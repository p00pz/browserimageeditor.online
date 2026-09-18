/**
 * Raster helpers — the small canvas vocabulary the two model engines share.
 *
 * Both halves of the background/eraser tool decode a file, scale pixels around, read them back and
 * encode a result. Written once here rather than twice, because the differences between the two
 * pipelines are entirely in the maths, not in how a canvas works.
 *
 * Everything is OffscreenCanvas: both engines run inside a worker, where `document` does not exist.
 * That is also why the tool can promise the page never freezes.
 */
import { CompressError } from './errors.js';

/** Returns [r, g, b, a] for a pixel. Alpha comes from the caller's own mask, not from the image. */
export function pixelAt(data, width, x, y) {
  const offset = (y * width + x) * 4;
  return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
}

/** A new canvas with a 2d context, sized in whole pixels. */
export function createCanvas(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const canvas = new OffscreenCanvas(w, h);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new CompressError('NO_CANVAS', 'This browser could not create a drawing surface.');
  return { canvas, context };
}

/**
 * Decodes a File into a bitmap with its EXIF orientation applied.
 *
 * `imageOrientation: 'from-image'` matters for exactly one case, and it is a common one: a phone
 * photo whose pixels are stored sideways with a rotation flag. The models run on pixels, so a
 * sideways photo would produce a sideways matte that still looked correct in a thumbnail.
 */
export async function decodeBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new CompressError('DECODE_FAILED', 'That file could not be decoded as an image.');
  }
}

/**
 * Draws a source into a new canvas at an arbitrary size.
 *
 * `imageSmoothingQuality: 'high'` is the browser's own resampling, which for the two sizes involved
 * here (down to 320/512, back up to a crop) is what every reference implementation of these models
 * does as well. It is not pica, and it is not claimed to be: the pixels outside the edited area are
 * never resampled at all, which is the promise that actually matters.
 */
export function drawScaled(source, width, height) {
  const { canvas, context } = createCanvas(width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Draws a sub-rectangle of a source into a new canvas at an arbitrary size. */
export function drawCropScaled(source, rect, width, height) {
  const { canvas, context } = createCanvas(width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function readPixels(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** Encodes a canvas. PNG is the only format asked for: both outputs need lossless alpha. */
export async function canvasToBlob(canvas, mime = 'image/png', quality) {
  const blob = await canvas.convertToBlob(quality === undefined ? { type: mime } : { type: mime, quality });
  if (!blob || blob.type !== mime) {
    throw new CompressError('ENCODE_FAILED', `This browser could not write ${mime}.`);
  }
  return blob;
}

/**
 * Hermite interpolation between two edges — the "edge cleanup" in both pipelines.
 *
 * A raw probability map from a segmentation network has a soft ramp at the boundary; resampling
 * that ramp up to a 3000px photo turns it into a wide grey halo that shows as a fringe against a
 * white background. Pushing the ramp through two edges narrows it to a pixel or two and turns
 * "78% sure" into a clean 0 or 255.
 */
export function smoothstep(edge0, edge1, value) {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Separable box blur over a single-channel float buffer, in place, with a running sum.
 *
 * Used at *model* resolution (320² or 512²) rather than at output resolution, and that is a real
 * decision: a 1px blur on a 320² matte becomes a wide soft edge once upscaled, which is what makes
 * the composite seam invisible, whereas blurring 6 million output pixels would be slow for the same
 * visual result.
 */
export function boxBlur(values, width, height, radius) {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return values;
  const window = r * 2 + 1;

  const pass = (src, dst, lineCount, lineLength, stride) => {
    for (let line = 0; line < lineCount; line += 1) {
      const base = line * stride;
      let sum = 0;
      for (let i = -r; i <= r; i += 1) sum += src[base + Math.min(lineLength - 1, Math.max(0, i))];
      for (let i = 0; i < lineLength; i += 1) {
        dst[base + i] = sum / window;
        const leaving = src[base + Math.min(lineLength - 1, Math.max(0, i - r))];
        const entering = src[base + Math.min(lineLength - 1, Math.max(0, i + r + 1))];
        sum += entering - leaving;
      }
    }
  };

  const horizontal = new Float32Array(values.length);
  pass(values, horizontal, height, width, width);
  pass(horizontal, values, width, height, 1);
  return values;
}
