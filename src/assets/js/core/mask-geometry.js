/**
 * Mask geometry — the arithmetic of "erase the thing I painted", with no DOM in sight.
 *
 * This is the part of the eraser that can be wrong in ways nobody notices until a photo comes back
 * with a blurry rectangle around the edit or, worse, with the *whole* picture quietly re-encoded.
 * So it is pure: mask in, crop rectangle out, and a compositing routine that works on plain pixel
 * buffers. `tests/mask.test.js` checks it without a browser and without a model.
 *
 * The pipeline these functions serve: a visitor paints over an object, we cut a padded rectangle
 * around the paint out of the **full-resolution** photo, run the inpainting model on that rectangle
 * at its fixed 512×512, then put only the painted pixels back. Everything outside the rectangle is
 * never resampled at all — that is the promise, and `stats()` below is how it gets measured rather
 * than asserted.
 */
import { CompressError } from './errors.js';

/** Minimum padding around the painted area, in pixels, so the model sees some context either side. */
const MIN_PADDING_PX = 32;

/** Alpha at or above this counts as painted. The brush is antialiased, so its fringe is not paint. */
export const PAINT_THRESHOLD = 32;

/**
 * The tight bounding box of everything painted.
 *
 * Returns null when nothing is painted, which the caller reports as "paint something first" rather
 * than as an error: it is a legitimate state for the tool to be in.
 */
export function maskBoundingBox(mask, width, height, { threshold = PAINT_THRESHOLD } = {}) {
  if (!mask || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new CompressError('INVALID_MASK', 'The painted area could not be read.');
  }
  if (mask.length < width * height) {
    throw new CompressError('INVALID_MASK', 'The painted area does not match the image size.');
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let painted = 0;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (mask[row + x] >= threshold) {
        painted += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, painted };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Chooses the rectangle that gets sent to the model, and decides when *not* to crop.
 *
 *   padding              fraction of the painted area's longer side, so a big paint gets
 *                        proportionally more context and a small one still gets some
 *   wholeImageFraction   above this share of the frame, cropping is pointless: the rectangle would
 *                        cover nearly everything, and the honest thing is to process the whole
 *                        image at 512×512 and say so
 *
 * The returned `note` is what the UI shows the visitor when the fallback happens. It is returned
 * rather than logged because a silent quality change is exactly what this project does not do.
 */
export function planInpaintCrop({
  box,
  imageWidth,
  imageHeight,
  padding = 0.12,
  wholeImageFraction = 0.6,
} = {}) {
  if (!box) throw new CompressError('EMPTY_MASK', 'Paint over the object you want removed first.');
  if (!(imageWidth >= 1) || !(imageHeight >= 1)) {
    throw new CompressError('INVALID_DIMENSIONS', 'That image reported a size of zero.');
  }

  const pad = Math.max(MIN_PADDING_PX, Math.round(Math.max(box.width, box.height) * padding));
  const x = clamp(box.x - pad, 0, imageWidth - 1);
  const y = clamp(box.y - pad, 0, imageHeight - 1);
  const right = clamp(box.x + box.width + pad, 1, imageWidth);
  const bottom = clamp(box.y + box.height + pad, 1, imageHeight);
  const crop = { x, y, width: right - x, height: bottom - y };

  const frameArea = imageWidth * imageHeight;
  const share = (crop.width * crop.height) / frameArea;

  if (share >= wholeImageFraction) {
    return {
      x: 0,
      y: 0,
      width: imageWidth,
      height: imageHeight,
      wholeImage: true,
      padded: pad,
      share,
      note:
        'The painted area covers most of the picture, so the whole photo was processed at 512 pixels instead of just the marked region. Everything outside your brush strokes is still the original pixels.',
    };
  }

  return { ...crop, wholeImage: false, padded: pad, share, note: null };
}

/**
 * Replaces the painted pixels of `base` with the model's `fill`, in place.
 *
 * Both buffers are RGB(A) pixel data of the same size, and `alpha` is one byte per pixel: 0 means
 * keep the original, 255 means take the fill. Everything in between is the feather, which is what
 * stops the edit showing a seam.
 *
 * The original alpha channel is left alone. A transparent PNG stays transparent, and an opaque photo
 * stays opaque, because erasing something is a colour edit rather than an opacity edit.
 */
export function compositeIntoRegion(base, region, fill, alpha, stride) {
  if (!base || !fill || !alpha) throw new CompressError('INVALID_MASK', 'The edit could not be composited.');
  const { x, y, width, height } = region;
  if (fill.length < width * height * 4 || alpha.length < width * height) {
    throw new CompressError('INVALID_MASK', 'The edit and the region it belongs to are different sizes.');
  }

  let changed = 0;
  for (let row = 0; row < height; row += 1) {
    const baseRow = (y + row) * stride + x;
    const localRow = row * width;
    for (let column = 0; column < width; column += 1) {
      const a = alpha[localRow + column];
      if (a === 0) continue;
      const offset = (baseRow + column) * 4;
      const from = (localRow + column) * 4;
      if (a === 255) {
        base[offset] = fill[from];
        base[offset + 1] = fill[from + 1];
        base[offset + 2] = fill[from + 2];
      } else {
        const keep = 255 - a;
        base[offset] = Math.round((fill[from] * a + base[offset] * keep) / 255);
        base[offset + 1] = Math.round((fill[from + 1] * a + base[offset + 1] * keep) / 255);
        base[offset + 2] = Math.round((fill[from + 2] * a + base[offset + 2] * keep) / 255);
      }
      changed += 1;
    }
  }
  return { changed };
}

/**
 * The whole-frame case of the above: `fill` and `alpha` are the same size as `base`.
 *
 * Two functions rather than one with an optional offset, because the eraser composites into a
 * rectangle of a full-resolution photo while the background remover composites the entire frame,
 * and the call sites read better for being explicit about which they are.
 */
export function compositeMasked(base, fill, alpha, width, height) {
  return compositeIntoRegion(base, { x: 0, y: 0, width, height }, fill, alpha, width);
}

/**
 * Measures the promise: every pixel outside the crop rectangle must be *identical* to the original.
 *
 * Returns the worst per-channel difference found outside the region, which must be 0. This exists
 * because "the rest of the photo is untouched" is the kind of claim that is easy to make and easy to
 * quietly break — one stray `drawImage` of the whole frame, one resample, and it is false. Any
 * change here has to keep the number this returns at 0.
 */
export function measureOutsideRegion(before, after, width, height, region) {
  let worst = 0;
  let differing = 0;
  const { x: rx, y: ry, width: rw, height: rh } = region;

  for (let y = 0; y < height; y += 1) {
    const insideRow = y >= ry && y < ry + rh;
    for (let x = 0; x < width; x += 1) {
      if (insideRow && x >= rx && x < rx + rw) continue;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs(before[offset + channel] - after[offset + channel]);
        if (delta > 0) {
          differing += 1;
          if (delta > worst) worst = delta;
        }
      }
    }
  }
  return { worst, differing };
}

/** A crop rectangle as a full-frame region, for the whole-image fallback and for measurement. */
export function fullRegion(width, height) {
  return { x: 0, y: 0, width, height };
}
