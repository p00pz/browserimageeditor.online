/**
 * Crop geometry — pure logic, no DOM.
 *
 * **Why this file exists rather than calling cropperjs for the output.** cropperjs 2.2 exposes
 * `$toCanvas()` on `CropperCanvas` only, not on the selection, so "give me just the selected
 * pixels" is not a supported call. Rather than reach into its internals, the crop tool uses
 * cropperjs for the interactive part (the drag handle, the ratio lock, the keyboard support) and
 * this module for the arithmetic: it returns the output size plus the exact affine matrix to hand
 * to `ctx.setTransform()` before drawing the source image once.
 *
 * That split has a second payoff — the transform is plain maths, so it is unit-tested here
 * instead of being verified by eye in a browser.
 *
 * The matrix is the six-value form canvas uses: `[a, b, c, d, e, f]`, meaning
 * `x' = a*x + c*y + e`, `y' = b*x + d*y + f`, and it maps *source image* pixels to output pixels.
 */
import { CompressError } from './errors.js';
import { assertPixelBudget, safeMaxPixels } from './engine-compress.js';

const QUARTER_TURNS = [0, 90, 180, 270];

/** Snaps any angle to the quarter turn the UI can actually mean. */
export function normaliseRotation(degrees) {
  const value = Number(degrees);
  if (!Number.isFinite(value)) return 0;
  const wrapped = ((value % 360) + 360) % 360;
  const nearest = Math.round(wrapped / 90) * 90;
  return QUARTER_TURNS.includes(nearest) ? nearest % 360 : 0;
}

/** Keeps a selection inside the image and gives it whole pixels. */
export function clampRect(rect, sourceWidth, sourceHeight) {
  if (!rect) throw new CompressError('INVALID_SELECTION', 'No crop area was selected.');
  const source = { width: Math.round(sourceWidth), height: Math.round(sourceHeight) };
  if (!(source.width >= 1) || !(source.height >= 1)) {
    throw new CompressError('INVALID_DIMENSIONS', 'That image reported a size of zero and cannot be cropped.');
  }

  const x = Math.min(Math.max(0, Math.round(Number(rect.x) || 0)), source.width - 1);
  const y = Math.min(Math.max(0, Math.round(Number(rect.y) || 0)), source.height - 1);
  const width = Math.min(Math.max(1, Math.round(Number(rect.width) || 0)), source.width - x);
  const height = Math.min(Math.max(1, Math.round(Number(rect.height) || 0)), source.height - y);

  return { x, y, width, height };
}

/* ---------- affine helpers (canvas order: a, b, c, d, e, f) ---------- */

export function translation(tx, ty) {
  return [1, 0, 0, 1, tx, ty];
}

/** Positive angles turn clockwise on screen, matching ctx.rotate(). */
export function rotation(degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, 0, 0];
}

export function scaling(sx, sy) {
  return [sx, 0, 0, sy, 0, 0];
}

/** `outer ∘ inner`: the inner transform runs first, then the outer one. */
export function compose(outer, inner) {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** Where a source point lands in the output. Used by the tests and by the worker's bounds check. */
export function applyMatrix(matrix, x, y) {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

function boundsOf(matrix, rect) {
  const corners = [
    applyMatrix(matrix, rect.x, rect.y),
    applyMatrix(matrix, rect.x + rect.width, rect.y),
    applyMatrix(matrix, rect.x + rect.width, rect.y + rect.height),
    applyMatrix(matrix, rect.x, rect.y + rect.height),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

const roundTo = (value) => Math.round(value * 1000) / 1000;

/**
 * The complete crop plan.
 *
 *   sourceWidth/sourceHeight  the decoded image
 *   rect                      the selection, in source-image pixels (cropperjs reports it that way)
 *   rotation                  0, 90, 180 or 270 clockwise, applied after the crop
 *   flipH / flipV             mirroring, applied in the output's frame
 *
 * Returns the output size, the clamped rectangle, and `matrix` ready for `ctx.setTransform(...)`.
 */
export function planCrop({
  sourceWidth,
  sourceHeight,
  rect,
  rotation: degrees = 0,
  flipH = false,
  flipV = false,
  maxPixels,
} = {}) {
  const clamped = clampRect(rect, sourceWidth, sourceHeight);
  const quarter = normaliseRotation(degrees);

  // Crop first (move the selection's origin to 0,0), then turn, then mirror.
  let matrix = compose(rotation(quarter), translation(-clamped.x, -clamped.y));
  if (flipH || flipV) {
    matrix = compose(scaling(flipH ? -1 : 1, flipV ? -1 : 1), matrix);
  }

  const bounds = boundsOf(matrix, clamped);
  // A quarter turn that is not a multiple of 180 swaps the output's width and height.
  const outputWidth = Math.max(1, Math.round(bounds.width));
  const outputHeight = Math.max(1, Math.round(bounds.height));

  // Shift the transformed rectangle back into the positive quadrant, so the draw starts at 0,0.
  matrix = compose(translation(-roundTo(bounds.minX), -roundTo(bounds.minY)), matrix);
  assertPixelBudget(outputWidth, outputHeight, maxPixels);

  return {
    outputWidth,
    outputHeight,
    rect: clamped,
    rotation: quarter,
    flipH: Boolean(flipH),
    flipV: Boolean(flipV),
    swapped: quarter === 90 || quarter === 270,
    matrix: matrix.map(roundTo),
  };
}

/** The first selection to show for an image: a centred box at `coverage` of the short side. */
export function initialSelection({ sourceWidth, sourceHeight, ratio = null, coverage = 0.8 } = {}) {
  const width = Math.max(1, Math.round(sourceWidth * coverage));
  const height = Math.max(1, Math.round(sourceHeight * coverage));
  const size =
    ratio === null
      ? { width, height }
      : width / height > ratio
        ? { width: Math.round(height * ratio), height }
        : { width, height: Math.round(width / ratio) };
  return {
    x: Math.round((sourceWidth - size.width) / 2),
    y: Math.round((sourceHeight - size.height) / 2),
    width: size.width,
    height: size.height,
  };
}
