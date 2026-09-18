/**
 * Resize planning — pure logic, no DOM.
 *
 * The browser capability (pica, plus a canvas to encode with) is injected by
 * ../workers/resize.worker.js, exactly as engine-compress.js receives its encoder. What lives
 * here is the decision that users actually notice: given a source size and whatever they typed,
 * what are the output pixels, and does that count as "scaled" or "the same"?
 *
 * Two rules are load-bearing:
 *   - With the aspect ratio locked, the image is fitted *inside* the box, so a 4000x3000 photo
 *     asked for 1600x1600 becomes 1600x1200 rather than a stretched square.
 *   - With `allowUpscale` off, a small image is left at its original size, because interpolation
 *     can invent pixels but never detail.
 */
import { CompressError } from './errors.js';
import { assertPixelBudget } from './engine-compress.js';

export { parseDimension } from './inputs.js';

/**
 * Output dimensions. `targetWidth`/`targetHeight` are null when the user left them blank, which
 * means "keep the original" on that axis.
 */
export function planResize({
  sourceWidth,
  sourceHeight,
  targetWidth = null,
  targetHeight = null,
  lockAspect = true,
  allowUpscale = false,
} = {}) {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
    throw new CompressError('INVALID_DIMENSIONS', 'That image reported a size of zero and cannot be resized.');
  }

  const width = positiveOrNull(targetWidth, 'width');
  const height = positiveOrNull(targetHeight, 'height');

  if (width === null && height === null) {
    return { width: Math.round(sourceWidth), height: Math.round(sourceHeight), scaled: false, ratio: 1 };
  }

  if (!lockAspect) {
    // Unlocked means the user wants exactly these pixels: a blank axis keeps the original size
    // rather than being an error, but the two are not coupled afterwards.
    const exactWidth = Math.round(width ?? sourceWidth);
    const exactHeight = Math.round(height ?? sourceHeight);
    return {
      width: Math.max(1, exactWidth),
      height: Math.max(1, exactHeight),
      scaled: exactWidth !== sourceWidth || exactHeight !== sourceHeight,
      ratio: exactWidth / Math.max(1, exactHeight) / (sourceWidth / sourceHeight),
    };
  }

  const ratios = [];
  if (width !== null) ratios.push(width / sourceWidth);
  if (height !== null) ratios.push(height / sourceHeight);

  let ratio = Math.min(...ratios);
  if (!allowUpscale && ratio > 1) ratio = 1;

  if (ratio === 1) {
    return { width: Math.round(sourceWidth), height: Math.round(sourceHeight), scaled: false, ratio: 1 };
  }

  const scaledWidth = Math.max(1, Math.round(sourceWidth * ratio));
  const scaledHeight = Math.max(1, Math.round(sourceHeight * ratio));
  return {
    width: scaledWidth,
    height: scaledHeight,
    scaled: scaledWidth !== sourceWidth || scaledHeight !== sourceHeight,
    ratio,
  };
}

function positiveOrNull(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CompressError('INVALID_DIMENSION', `The ${label} must be a positive number, or blank to keep the original.`);
  }
  return amount;
}

/**
 * Keeps a planned resize inside the pixel budget. A canvas this large is a reliable way to make
 * a browser tab fall over, so it is refused with a message that says what to do instead.
 */
export function assertResizeBudget(width, height, maxPixels) {
  assertPixelBudget(width, height, maxPixels);
  return { width, height };
}

/** How much smaller (or larger) the result is, as a percentage. Positive means it shrank. */
export function scalePercent(sourceWidth, sourceHeight, width, height) {
  if (!Number.isFinite(sourceWidth * sourceHeight) || sourceWidth * sourceHeight <= 0) return 0;
  const before = sourceWidth * sourceHeight;
  const after = width * height;
  return Math.round(((before - after) / before) * 1000) / 10;
}
