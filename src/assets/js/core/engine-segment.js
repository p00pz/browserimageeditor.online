/**
 * Background removal engine — U²-Netp behind one function, pure apart from the canvases it draws on.
 *
 * **The contract is the model's own, not a guess.** U²-Net ONNX exports differ in input naming,
 * padding and normalisation, and getting any of them wrong produces a matte that looks plausible and
 * is subtly wrong everywhere. The values below come from the exporting repository's own
 * `config.json` and `preprocessor_config.json`, which is why this particular repository was chosen
 * over the other Apache-2.0 candidates:
 *
 *   input name      input.1
 *   input shape     [1, 3, 320, 320] float32
 *   the composite   output named 1959, [1, 1, 320, 320]
 *   normalisation   (value/255 − mean) / std, ImageNet mean and standard deviation
 *   aspect ratio    preserved, letterboxed rather than stretched
 *
 * The padding is ours: the repository pads to the target size and so do we, centred, with zeros in
 * *normalised* space — which is the mean of the training data, not black. Padding a normalised
 * tensor with black pixels instead is a small, quiet way to make an edge-detector see a dark border.
 *
 * **Everything downstream is measured, not assumed.** Output selection reads the tensor's actual
 * `dims` rather than trusting a shape written down in a config file, the matte's own min/max are
 * normalised before thresholding (U²-Net outputs are not reliably bounded), and the finished alpha
 * is reported back as a coverage number so the result panel can say what actually happened.
 */
import { CompressError } from './errors.js';
import { assertPixelBudget } from './engine-compress.js';
import { boxBlur, canvasToBlob, createCanvas, drawScaled, readPixels, smoothstep } from './raster.js';

export const SEGMENT_CONTRACT = {
  /** From the exporting repository's config.json. */
  inputName: 'input.1',
  /** The composite output; the export also carries six side outputs we do not need. */
  compositeOutput: '1959',
  /** From the exporting repository's preprocessor_config.json. */
  size: 320,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  /** Every output that could be the final matte, in preference order. */
  acceptableOutputs: ['1959'],
};

/**
 * The edge curve. A segmentation network's boundary is a ramp, and resampling that ramp up to a
 * 3000px photo turns it into a grey halo — the classic fringe that appears as a pale outline against
 * a white background. Pushing the ramp through these two edges, then blurring at model resolution,
 * is the "edge cleanup": it narrows the transition to a pixel or two at full size.
 */
export const EDGE_CLEANUP = { low: 0.35, high: 0.75, blurRadius: 1 };

/** Letterbox geometry for one image: the scale, the inner size, and the centring offsets. */
export function letterboxFor(width, height, size = SEGMENT_CONTRACT.size) {
  const scale = Math.min(size / width, size / height);
  const innerWidth = Math.max(1, Math.min(size, Math.round(width * scale)));
  const innerHeight = Math.max(1, Math.min(size, Math.round(height * scale)));
  return {
    scale,
    innerWidth,
    innerHeight,
    padX: Math.floor((size - innerWidth) / 2),
    padY: Math.floor((size - innerHeight) / 2),
    size,
  };
}

/**
 * Builds the model's input tensor: NCHW float32, letterboxed, normalised.
 *
 * Returns a plain object rather than an ORT tensor so this half of the pipeline can be unit-tested
 * in Node — the shapes are where the boring bugs live.
 */
export function segmentInput(bitmap, { size = SEGMENT_CONTRACT.size, mean = SEGMENT_CONTRACT.mean, std = SEGMENT_CONTRACT.std } = {}) {
  const box = letterboxFor(bitmap.width, bitmap.height, size);
  const inner = drawScaled(bitmap, box.innerWidth, box.innerHeight);
  const pixels = readPixels(inner).data;

  const plane = size * size;
  const data = new Float32Array(plane * 3);
  for (let y = 0; y < box.innerHeight; y += 1) {
    for (let x = 0; x < box.innerWidth; x += 1) {
      const from = (y * box.innerWidth + x) * 4;
      const to = (y + box.padY) * size + (x + box.padX);
      data[to] = (pixels[from] / 255 - mean[0]) / std[0];
      data[plane + to] = (pixels[from + 1] / 255 - mean[1]) / std[1];
      data[plane * 2 + to] = (pixels[from + 2] / 255 - mean[2]) / std[2];
    }
  }
  return { data, dims: [1, 3, size, size], box };
}

/**
 * Picks the matte out of whatever the session returned.
 *
 * `dims` is read from the tensor itself; a session that hands back `[1, 1, 320, 320]` and one that
 * hands back `[1, 320, 320]` both work. A single-channel output is the composite; a multi-channel
 * one is the export's set of side outputs, where channel 0 is the composite and the rest are
 * intermediate scales that would make a worse matte.
 */
export function matteFromTensor(tensor) {
  const dims = tensor?.dims ?? [];
  const values = tensor?.data;
  if (!values || !Array.isArray(dims) || dims.length < 3) {
    throw new CompressError('MODEL_CONTRACT_MISMATCH', 'The model returned something this tool does not understand.');
  }
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  const channels = dims.length >= 4 ? dims[1] : 1;
  if (channels < 1) {
    throw new CompressError('MODEL_CONTRACT_MISMATCH', 'The model returned an empty matte.');
  }
  return { values, width, height, channels, single: values.subarray(0, width * height) };
}

/**
 * Matte → alpha, 0…1, at the matte's own resolution, with the letterbox removed.
 *
 * The order matters and each step is there for a reason: normalise by the matte's own range (the
 * network is not calibrated to 0…1), crop the padding away *before* normalising (a padded border of
 * zeros would drag the minimum down and wash the whole matte out), then clean the edge.
 */
export function alphaFromMatte({ values, width, height }, box, { edge = EDGE_CLEANUP } = {}) {
  const inner = new Float32Array(box.innerWidth * box.innerHeight);
  let min = Infinity;
  let max = -Infinity;

  for (let y = 0; y < box.innerHeight; y += 1) {
    for (let x = 0; x < box.innerWidth; x += 1) {
      const value = values[(y + box.padY) * width + (x + box.padX)];
      inner[y * box.innerWidth + x] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }

  const range = max - min;
  const scale = range > 1e-6 ? 1 / range : 0;
  for (let index = 0; index < inner.length; index += 1) {
    const normalised = scale === 0 ? 0 : (inner[index] - min) * scale;
    inner[index] = smoothstep(edge.low, edge.high, normalised);
  }
  boxBlur(inner, box.innerWidth, box.innerHeight, edge.blurRadius);
  return inner;
}

/**
 * Turns an alpha matte into a source-resolution alpha byte buffer.
 *
 * The matte goes back up through a canvas, so the browser's own resampling does the interpolation
 * once, quickly, rather than JavaScript doing it per pixel. Alpha rides in the red channel and the
 * green/blue channels are forced to 255, which keeps the buffer from being treated as premultiplied
 * on the way through.
 */
export function upscaleAlpha(alpha, width, height, targetWidth, targetHeight) {
  const { canvas, context } = createCanvas(width, height);
  const data = context.createImageData(width, height);
  for (let index = 0; index < width * height; index += 1) {
    const value = Math.round(Math.min(1, Math.max(0, alpha[index])) * 255);
    const offset = index * 4;
    data.data[offset] = value;
    data.data[offset + 1] = value;
    data.data[offset + 2] = value;
    data.data[offset + 3] = 255;
  }
  context.putImageData(data, 0, 0);

  const scaled = drawScaled(canvas, targetWidth, targetHeight);
  const pixels = readPixels(scaled).data;
  const out = new Uint8ClampedArray(targetWidth * targetHeight);
  for (let index = 0; index < out.length; index += 1) out[index] = pixels[index * 4];
  return out;
}

function parseFill(background) {
  if (!background || background.mode !== 'color') return null;
  const hex = String(background.color ?? '').trim();
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new CompressError('INVALID_BACKGROUND', 'That background colour could not be read.');
  const value = Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/**
 * The whole feature: image in, transparent (or filled) PNG out.
 *
 *   bitmap      decoded source, full resolution
 *   session     an ORT session for the segmentation model
 *   ort         the runtime module, for Tensor construction
 *   background  { mode: 'transparent' } or { mode: 'color', color: '#ffffff' }
 */
export async function removeBackground({ bitmap, session, ort, outputName, onProgress, signal, options = {} }) {
  assertPixelBudget(bitmap.width, bitmap.height);
  const fill = parseFill(options.background);

  onProgress?.({ phase: 'preprocess', ratio: 0.15 });
  const input = segmentInput(bitmap);
  if (signal?.aborted) throw new CompressError('ABORTED', 'Background removal was cancelled.');

  onProgress?.({ phase: 'inference', ratio: 0.35 });
  const tensor = new ort.Tensor('float32', input.data, input.dims);

  let results;
  try {
    const fetches = outputName ? [outputName] : undefined;
    results = fetches ? await session.run({ [SEGMENT_CONTRACT.inputName]: tensor }, fetches) : await session.run({ [SEGMENT_CONTRACT.inputName]: tensor });
  } catch (error) {
    const { mapRuntimeError } = await import('./onnx.js');
    throw mapRuntimeError(error, 'The background could not be removed on this device.');
  }
  if (signal?.aborted) throw new CompressError('ABORTED', 'Background removal was cancelled.');

  const first = results[outputName] ?? Object.values(results)[0];
  const matte = matteFromTensor(first);

  onProgress?.({ phase: 'composite', ratio: 0.8 });
  const alpha = alphaFromMatte(matte, input.box);
  const fullAlpha = upscaleAlpha(alpha, input.box.innerWidth, input.box.innerHeight, bitmap.width, bitmap.height);

  const { canvas, context } = createCanvas(bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0);
  const frame = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = frame.data;

  let kept = 0;
  if (fill) {
    for (let index = 0; index < fullAlpha.length; index += 1) {
      const a = fullAlpha[index];
      kept += a;
      const offset = index * 4;
      const inverse = 255 - a;
      pixels[offset] = Math.round((fill.r * inverse + pixels[offset] * a) / 255);
      pixels[offset + 1] = Math.round((fill.g * inverse + pixels[offset + 1] * a) / 255);
      pixels[offset + 2] = Math.round((fill.b * inverse + pixels[offset + 2] * a) / 255);
      pixels[offset + 3] = 255;
    }
  } else {
    for (let index = 0; index < fullAlpha.length; index += 1) {
      kept += fullAlpha[index];
      pixels[index * 4 + 3] = fullAlpha[index];
    }
  }
  context.putImageData(frame, 0, 0);

  onProgress?.({ phase: 'encode', ratio: 0.92 });
  const blob = await canvasToBlob(canvas, 'image/png');
  onProgress?.({ phase: 'encode', ratio: 1 });

  return {
    blob,
    meta: {
      outputMime: 'image/png',
      width: bitmap.width,
      height: bitmap.height,
      /** Mean alpha, i.e. the share of the picture the model kept. */
      subjectShare: kept / (255 * fullAlpha.length),
      background: fill ? 'color' : 'transparent',
      matteSize: input.box.size,
      sourceBytes: blob.size,
    },
  };
}
