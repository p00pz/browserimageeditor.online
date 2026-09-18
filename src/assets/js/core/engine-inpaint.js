/**
 * Object erasing engine — LaMa, run on a crop rather than on the whole photo.
 *
 * **The contract, verified against the published file rather than assumed.** Reading the ONNX
 * protobuf directly showed the graph takes `image` as float32 `[batch, 3, 512, 512]` and `mask` as
 * float32 `[batch, 1, 512, 512]`, and that its very first nodes are `Sub(1 - mask)`,
 * `Mul(image, 1 - mask)` and `Concat(mul, mask)`. Two consequences, both load-bearing: the input
 * image is handed over **unmasked**, because the graph masks it itself; and the mask is the
 * contract's 0/1 form, not a soft matte.
 *
 * **Why the crop exists.** The model is fixed at 512×512 and most photos are not. Downscaling the
 * whole photo to 512 destroys detail everywhere; cutting a padded rectangle around the brush strokes,
 * running the model on that, and putting back only the painted pixels keeps every untouched pixel of
 * a 3000px photo exactly as it was. The trade is that a fill has 512 pixels of model output to work
 * with across the crop, which is generous for an object-shaped hole and thin for a hole covering
 * half the frame — which is why the whole-image fallback below exists, and why it tells the visitor
 * when it happens instead of quietly getting worse.
 *
 * **The mask the composite uses is not the mask the model gets.** The model gets the hard 0/1 edges
 * its contract specifies; the composite alpha is the same mask put back through the browser's
 * bilinear resampling with a 1px blur at model resolution, which is roughly a 6px feather in a
 * 3000px photo. That feather is what stops the edit showing a rectangular seam.
 */
import { CompressError } from './errors.js';
import { assertPixelBudget } from './engine-compress.js';
import { boxBlur, canvasToBlob, createCanvas, drawCropScaled, drawScaled, readPixels } from './raster.js';
import { compositeIntoRegion, maskBoundingBox, planInpaintCrop } from './mask-geometry.js';

export const INPAINT_CONTRACT = {
  size: 512,
  imageInput: 'image',
  maskInput: 'mask',
  output: 'output',
};

/** Feather applied to the *composite* alpha only, at model resolution. */
const COMPOSITE_BLUR = 1;

/**
 * The 512×512 image tensor: RGB, values divided by 255, no masking applied.
 */
export function inpaintImageInput(bitmap, crop, size = INPAINT_CONTRACT.size) {
  const canvas = drawCropScaled(bitmap, crop, size, size);
  const pixels = readPixels(canvas).data;
  const plane = size * size;
  const data = new Float32Array(plane * 3);
  for (let index = 0; index < plane; index += 1) {
    const from = index * 4;
    data[index] = pixels[from] / 255;
    data[plane + index] = pixels[from + 1] / 255;
    data[plane * 2 + index] = pixels[from + 2] / 255;
  }
  return { data, dims: [1, 3, size, size] };
}

/**
 * The 512×512 mask tensor, hard 0/1 as the contract requires, plus the soft copy the composite uses.
 *
 * `sourceMask` is drawn from a canvas holding the full-resolution painted mask, cropped to the same
 * rectangle as the image. Scaling that crop with smoothing on gives the model a mask whose edges sit
 * within a pixel of where the brush actually was — close enough that the contract's "1 = erase"
 * stays true, while the composite alpha below is derived from the same array so the two can never
 * disagree about what was painted.
 */
export function inpaintMaskInput(sourceMaskCanvas, crop, size = INPAINT_CONTRACT.size) {
  const canvas = drawCropScaled(sourceMaskCanvas, crop, size, size);
  const pixels = readPixels(canvas).data;
  const data = new Float32Array(size * size);
  const soft = new Float32Array(size * size);

  for (let index = 0; index < data.length; index += 1) {
    const value = pixels[index * 4] / 255;
    data[index] = value > 0.5 ? 1 : 0;
    soft[index] = value;
  }
  boxBlur(soft, size, size, COMPOSITE_BLUR);

  return { data, dims: [1, 1, size, size], soft };
}

/** Reads the model's crop back as RGB pixels in the 0–255 range it already promises. */
export function inpaintResultPixels(tensor, size = INPAINT_CONTRACT.size) {
  const dims = tensor?.dims ?? [];
  const values = tensor?.data;
  if (!values || dims.length !== 4 || dims[1] < 3) {
    throw new CompressError('MODEL_CONTRACT_MISMATCH', 'The eraser model returned something this tool does not understand.');
  }
  const plane = dims[2] * dims[3];
  const { canvas, context } = createCanvas(dims[3], dims[2]);
  const frame = context.createImageData(dims[3], dims[2]);
  for (let index = 0; index < plane; index += 1) {
    const offset = index * 4;
    // Already 0–255 per the contract; clamped rather than rescaled, because a model that overshoots
    // slightly at a boundary is normal and rescaling would darken the whole crop to compensate.
    frame.data[offset] = Math.max(0, Math.min(255, Math.round(values[index])));
    frame.data[offset + 1] = Math.max(0, Math.min(255, Math.round(values[plane + index])));
    frame.data[offset + 2] = Math.max(0, Math.min(255, Math.round(values[plane * 2 + index])));
    frame.data[offset + 3] = 255;
  }
  context.putImageData(frame, 0, 0);
  return canvas;
}

/** The painted mask as a canvas, so the browser can crop and scale it the same way as the photo. */
export function maskCanvasFrom(mask, width, height) {
  const { canvas, context } = createCanvas(width, height);
  const frame = context.createImageData(width, height);
  for (let index = 0; index < width * height; index += 1) {
    const value = mask[index];
    const offset = index * 4;
    frame.data[offset] = value;
    frame.data[offset + 1] = value;
    frame.data[offset + 2] = value;
    frame.data[offset + 3] = 255;
  }
  context.putImageData(frame, 0, 0);
  return canvas;
}

/**
 * The whole feature: photo plus painted mask in, PNG out, with everything outside the crop untouched.
 *
 *   bitmap  decoded source at full resolution
 *   mask    one byte per source pixel, painted area above ~32
 */
export async function eraseObject({
  bitmap,
  mask,
  session,
  ort,
  outputName,
  onProgress,
  signal,
  options = {},
}) {
  assertPixelBudget(bitmap.width, bitmap.height);
  const maskWidth = options.maskWidth ?? bitmap.width;
  const maskHeight = options.maskHeight ?? bitmap.height;
  if (maskWidth !== bitmap.width || maskHeight !== bitmap.height) {
    throw new CompressError('INVALID_MASK', 'The painted area does not line up with the image.');
  }

  const box = maskBoundingBox(mask, maskWidth, maskHeight);
  const crop = planInpaintCrop({ box, imageWidth: bitmap.width, imageHeight: bitmap.height });

  onProgress?.({ phase: 'preprocess', ratio: 0.15 });
  const size = INPAINT_CONTRACT.size;
  const image = inpaintImageInput(bitmap, crop, size);
  const maskCanvas = maskCanvasFrom(mask, maskWidth, maskHeight);
  const painted = inpaintMaskInput(maskCanvas, crop, size);
  if (signal?.aborted) throw new CompressError('ABORTED', 'Object removal was cancelled.');

  onProgress?.({ phase: 'inference', ratio: 0.4 });
  let results;
  try {
    const feeds = {
      [INPAINT_CONTRACT.imageInput]: new ort.Tensor('float32', image.data, image.dims),
      [INPAINT_CONTRACT.maskInput]: new ort.Tensor('float32', painted.data, painted.dims),
    };
    results = outputName ? await session.run(feeds, [outputName]) : await session.run(feeds);
  } catch (error) {
    const { mapRuntimeError } = await import('./onnx.js');
    throw mapRuntimeError(error, 'The object could not be removed on this device.');
  }
  if (signal?.aborted) throw new CompressError('ABORTED', 'Object removal was cancelled.');

  onProgress?.({ phase: 'composite', ratio: 0.85 });
  const fillCanvas = inpaintResultPixels(results[outputName] ?? Object.values(results)[0], size);
  const fill = readPixels(drawScaled(fillCanvas, crop.width, crop.height)).data;

  // The composite alpha, back at crop resolution: the same soft mask the model saw, resampled the
  // same way the fill was, so the two are aligned to within a pixel.
  const alphaCanvas = (() => {
    const { canvas, context } = createCanvas(size, size);
    const frame = context.createImageData(size, size);
    for (let index = 0; index < size * size; index += 1) {
      const value = Math.max(0, Math.min(255, Math.round(painted.soft[index] * 255)));
      const offset = index * 4;
      frame.data[offset] = value;
      frame.data[offset + 1] = value;
      frame.data[offset + 2] = value;
      frame.data[offset + 3] = 255;
    }
    context.putImageData(frame, 0, 0);
    return canvas;
  })();
  const alphaPixels = readPixels(drawScaled(alphaCanvas, crop.width, crop.height)).data;
  const alpha = new Uint8ClampedArray(crop.width * crop.height);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = alphaPixels[index * 4];

  const { canvas, context } = createCanvas(bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0);
  const frame = context.getImageData(0, 0, canvas.width, canvas.height);
  const { changed } = compositeIntoRegion(frame.data, crop, fill, alpha, canvas.width);
  context.putImageData(frame, 0, 0);

  onProgress?.({ phase: 'encode', ratio: 0.95 });
  const blob = await canvasToBlob(canvas, 'image/png');
  onProgress?.({ phase: 'encode', ratio: 1 });

  return {
    blob,
    meta: {
      outputMime: 'image/png',
      width: bitmap.width,
      height: bitmap.height,
      sourceBytes: blob.size,
      crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
      wholeImage: crop.wholeImage,
      note: crop.note,
      paintedPixels: box.painted,
      changedPixels: changed,
      modelSize: size,
      modelCropShare: (crop.width * crop.height) / (bitmap.width * bitmap.height),
    },
  };
}
