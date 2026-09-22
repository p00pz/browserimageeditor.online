import { upscalePixels, upscaleSize } from '../core/upscale.js';
/**
 * Enhance worker — same contract as the other four, with one extra entry point.
 *
 *   capabilities()                                 -> { supported, missing[], filterPath, ... }
 *   previews({ jobId, file, options }, onProgress)  -> { items: [{ presetId, blob }], correction, ... }
 *   enhance({ jobId, file, options }, onProgress)   -> { blob, meta }
 *   selfTest()                                      -> { filterPath, maxDelta, measured }
 *   cancel(jobId)                                   -> void
 *
 * Four things worth knowing before editing:
 *
 *   - **`onProgress` is a separate top-level argument.** Same reason recorded in
 *     compress.worker.js: comlink only wires top-level arguments, so a callback nested inside the
 *     payload object gets structurally cloned and throws on the function.
 *
 *   - **The five thumbnails come from one decode.** `previews()` decodes the dropped photo once and
 *     downscales it once, then grades that same small buffer five times. A visitor dragging a 12 MP
 *     photo in gets their thumbnail row from a 160px-wide plane, not five full-size passes. The engine
 *     copies before it touches anything, so the small buffer is read-only between presets.
 *
 *   - **`ctx.filter` here is a drawImage filter, not a putImageData one.** `putImageData` ignores
 *     `ctx.filter` entirely by specification, so graded pixels are written to a canvas first and then
 *     *drawn* through the filter onto the destination. That is also why the capability probe reads the
 *     property back: a browser that ignores the setter needs the manual path, and the report says which
 *     one is in use instead of silently producing a different picture.
 *
 *   - **The output keeps the input's own format** where that is possible, and falls back to JPEG once
 *     if the encoder refuses it (an AVIF decode, say). `meta.outputMime` is read off the encoded blob,
 *     so the result panel can never claim a format the file does not have.
 *
 * Failures are thrown as plain serializeable `{ code, message }` objects: structured cloning drops
 * custom properties off an Error subclass, so `error.code` would not survive the trip otherwise.
 */
import * as Comlink from 'comlink';

import { CompressError, safeMaxPixels } from '../core/engine-compress.js';
import { encodeOptions, needsOpaqueBackdrop } from '../core/engine-convert.js';
import {
  applyFilterEquivalents,
  assertEnhanceBudget,
  cssFilterFor,
  ENHANCE_PRESETS,
  enhancePixels,
  histogramChannels,
} from '../core/engine-enhance.js';

/**
 * Preset thumbnails are judged at a glance, so they only need to be as wide as the row is. 160 px is
 * what the row renders at, and the encode — not the pixels — is the expensive part at this size.
 */
const PREVIEW_WIDTH = 160;
const PREVIEW_MIME = 'image/jpeg';
const PREVIEW_QUALITY = 0.92;

/** What a photo is re-encoded as when its own format cannot be written back (HEIC or AVIF input). */
const FALLBACK_OUTPUT_MIME = 'image/jpeg';
const OUTPUT_QUALITY = 0.95;

const controllers = new Map();
const capabilityReport = detectCapabilities();

function detectCapabilities() {
  const missing = [];
  if (typeof createImageBitmap !== 'function') missing.push('createImageBitmap');
  if (typeof OffscreenCanvas !== 'function') {
    missing.push('OffscreenCanvas');
    return { supported: false, missing, filterPath: 'none' };
  }
  const probe = new OffscreenCanvas(1, 1);
  if (typeof probe.getContext !== 'function') missing.push('OffscreenCanvas.getContext');
  if (typeof probe.convertToBlob !== 'function') missing.push('OffscreenCanvas.convertToBlob');

  const supported = missing.length === 0;
  return { supported, missing, filterPath: supported ? detectFilterPath(probe) : 'none' };
}

/**
 * Whether this engine's 2D context honours `ctx.filter`.
 *
 * Setting the property and reading it back is not proof that the filter is applied while compositing —
 * for that, `selfTest()` compares the two paths pixel by pixel when a page asks. What this answers
 * cheaply, on worker start, is whether the setter exists at all.
 */
function detectFilterPath(probe) {
  try {
    const context = probe.getContext('2d');
    if (!context) return 'none';
    context.filter = 'brightness(0.5)';
    const accepted = context.filter === 'brightness(0.5)';
    context.filter = 'none';
    return accepted ? 'filter' : 'manual';
  } catch {
    return 'manual';
  }
}

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw { code: 'DECODE_FAILED', message: 'That file could not be decoded as an image.' };
  }
}

/** Draws an image source into a fresh canvas, filling white first when the format needs a backdrop. */
function drawTo(width, height, source, { backdrop = false, smoothing = 'low', filter = 'none' } = {}) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (backdrop) {
    // Filling first only helps because the pixels are drawn *onto* it: putImageData would replace the
    // fill, and with it the alpha, rather than composite over it.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.imageSmoothingQuality = smoothing;
  if (filter !== 'none') context.filter = filter;
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

/**
 * The one browser step the engine cannot do itself: brightness/contrast/saturate/grayscale on the GPU.
 *
 * Built to land as close as possible to `applyFilterEquivalents()` in the engine — `selfTest()` reports
 * the actual difference, which measured 4 code values out of 255 at worst, not zero. Smoothing is off
 * because the draw is 1:1, and any smoothing would be a resample nobody asked for.
 */
function gradeWithFilter(pixels, filter, width, height) {
  const source = new OffscreenCanvas(width, height);
  source.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  const target = new OffscreenCanvas(width, height);
  const context = target.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.filter = filter;
  context.drawImage(source, 0, 0);
  context.filter = 'none';
  return new Uint8ClampedArray(context.getImageData(0, 0, width, height).data);
}

/**
 * The `deps` object `enhancePixels()` expects: the injected canvas step when this engine has one, and
 * the image width, which sharpening needs to know where rows end.
 */
function engineDeps(width, height) {
  if (capabilityReport.filterPath !== 'filter') return { width };
  return { width, gradeWithFilter: (pixels, filter) => gradeWithFilter(pixels, filter, width, height) };
}

/**
 * The format to write.
 *
 * An explicit request wins. Otherwise the photo keeps its own format, which is what makes enhancing a
 * JPEG a JPEG rather than a ten-times-larger PNG. Container formats that were only ever *decoded* are
 * excluded here and land on the JPEG fallback in `encodeResult`.
 */
function resolveOutputMime(options, file) {
  const requested = options.outputMime;
  if (typeof requested === 'string' && requested.startsWith('image/')) return requested;
  const own = file?.type;
  const decodable = typeof own === 'string' && own.startsWith('image/');
  if (decodable && own !== 'image/heic' && own !== 'image/heif' && own !== 'image/avif') return own;
  return FALLBACK_OUTPUT_MIME;
}

function toPlainError(error, signal, fallback) {
  if (error instanceof CompressError) return { code: error.code, message: error.message };
  if (error && typeof error.code === 'string') return error;
  if (signal?.aborted || error?.name === 'AbortError') {
    return { code: 'ABORTED', message: 'Enhancing was cancelled.' };
  }
  if (error instanceof RangeError || /allocation|memory|too large/i.test(error?.message ?? '')) {
    // The one failure a visitor can act on: a phone asked to hold a very large image's pixels.
    return {
      code: 'IMAGE_TOO_LARGE',
      message: 'This image was too large to enhance on this device. Try a smaller photo, or a desktop browser.',
    };
  }
  return { code: 'INTERNAL', message: error?.message || fallback };
}

function throwIfAborted(signal) {
  if (signal.aborted) throw { code: 'ABORTED', message: 'Enhancing was cancelled.' };
}

function assertUsable({ jobId, file }) {
  if (!capabilityReport.supported) {
    throw {
      code: 'UNSUPPORTED',
      message: `This browser is missing ${capabilityReport.missing.join(', ')}, so photos cannot be enhanced on your device here.`,
    };
  }
  if (!jobId) throw { code: 'INVALID_JOB', message: 'An enhance job needs an id.' };
  if (!file || file.size === 0) throw { code: 'INVALID_INPUT', message: 'No image file was provided.' };
}

async function blobFrom(canvas, mime, quality) {
  try {
    return await canvas.convertToBlob(encodeOptions({ mime, quality }));
  } catch {
    throw { code: 'ENCODE_FAILED', message: 'The result could not be encoded on this device.' };
  }
}

/**
 * Encodes the graded stage, flattening onto white when the format cannot store alpha, and retrying once
 * as JPEG if the encoder refuses the format we asked for.
 *
 * The retry cannot silently misreport itself: the returned `mime` on the fallback path is the fallback,
 * and the blob's own type is what the result panel prints.
 */
async function encodeResult(stage, { width, height }, mime) {
  const target = needsOpaqueBackdrop(mime) ? drawTo(width, height, stage, { backdrop: true }) : stage;
  try {
    return { blob: await blobFrom(target, mime, mime === 'image/png' ? undefined : OUTPUT_QUALITY), mime };
  } catch (error) {
    if (mime === 'image/png') throw error;
    const blob = await blobFrom(stage, 'image/png');
    return { blob, mime: 'image/png', fallback: true };
  }
}

/**
 * The before-numbers the result panel reports, measured on the *original* pixels.
 *
 * A real measurement rather than a claim, which is what lets the panel say the black point moved from
 * 18 to 0: these are the histograms the correction itself was computed from.
 */
function histogramSummary(pixels) {
  const histograms = histogramChannels(pixels);
  return {
    min: histograms.map((histogram) => histogram.findIndex((count) => count > 0)),
    max: histograms.map((histogram) => {
      for (let bin = histogram.length - 1; bin >= 0; bin -= 1) {
        if (histogram[bin] > 0) return bin;
      }
      return 0;
    }),
  };
}

/**
 * The thumbnail row: one decode, one downscale, five grades.
 *
 * Each preset is applied at 100 % intensity, because a thumbnail's job is to show what the preset *is*.
 * The visitor's intensity slider then applies to the full-size image they choose.
 */
async function previews(payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  assertUsable(payload);

  const controller = new AbortController();
  controllers.set(jobId, controller);
  const { signal } = controller;

  let bitmap = null;
  try {
    onProgress?.({ jobId, phase: 'probe', ratio: 0.05 });
    bitmap = await decode(file);
    throwIfAborted(signal);

    const width = Math.max(1, Math.min(options.previewWidth || PREVIEW_WIDTH, bitmap.width));
    const height = Math.max(1, Math.round((bitmap.height / bitmap.width) * width));
    const small = drawTo(width, height, bitmap, { backdrop: true, smoothing: 'high' });
    const pixels = new Uint8ClampedArray(small.getContext('2d').getImageData(0, 0, width, height).data);
    const deps = engineDeps(width, height);

    const items = [];
    let correction = null;
    for (let index = 0; index < ENHANCE_PRESETS.length; index += 1) {
      throwIfAborted(signal);
      const preset = ENHANCE_PRESETS[index];
      // The engine copies before it writes, so `pixels` is still the ungraded plane each time round —
      // every preset gets its own auto-correct, and none of them inherits the previous one's output.
      const { pixels: graded, meta } = enhancePixels(pixels, { presetId: preset.id, intensity: 1 }, deps);
      correction ??= meta.correction;

      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').putImageData(new ImageData(graded, width, height), 0, 0);
      items.push({ presetId: preset.id, blob: await blobFrom(canvas, PREVIEW_MIME, PREVIEW_QUALITY) });
      onProgress?.({
        jobId,
        phase: 'previews',
        ratio: 0.1 + (0.85 * (index + 1)) / ENHANCE_PRESETS.length,
      });
    }

    return {
      items,
      correction,
      width: bitmap.width,
      height: bitmap.height,
      previewWidth: width,
      previewHeight: height,
      filterPath: capabilityReport.filterPath,
    };
  } catch (error) {
    throw toPlainError(error, signal, 'The previews could not be generated.');
  } finally {
    bitmap?.close?.();
    controllers.delete(jobId);
  }
}

async function enhance(payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  assertUsable(payload);

  const controller = new AbortController();
  controllers.set(jobId, controller);
  const { signal } = controller;

  let bitmap = null;
  try {
    onProgress?.({ jobId, phase: 'probe', ratio: 0.05 });
    bitmap = await decode(file);
    throwIfAborted(signal);

    // The budget is the platform's own canvas limit: an iPhone photo past it cannot be held on a
    // canvas here at all, so it is refused with a reason rather than crashing mid-pipeline.
    const budget = assertEnhanceBudget(bitmap.width, bitmap.height, safeMaxPixels(options.maxPixels, navigator.userAgent));
    const { width, height } = budget;
    const output = upscaleSize(width, height, options.scale ?? 1, Math.min(16000000, safeMaxPixels(options.maxPixels, navigator.userAgent)));

    onProgress?.({ jobId, phase: 'analyse', ratio: 0.2 });
    const source = drawTo(width, height, bitmap);
    // `enhancePixels` copies before it writes, so this plane stays the original for the before-numbers.
    const pixels = new Uint8ClampedArray(source.getContext('2d').getImageData(0, 0, width, height).data);

    const { pixels: enhanced, meta } = enhancePixels(
      pixels,
      {
        presetId: options.presetId,
        intensity: options.intensity,
        advanced: options.advanced ?? null,
      },
      engineDeps(width, height),
    );

    onProgress?.({ jobId, phase: 'grade', ratio: 0.55 });
    throwIfAborted(signal);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const scaled = await upscalePixels(enhanced, width, height, output.scale, { signal,
      onProgress: (ratio) => onProgress?.({ jobId, phase: 'upscale', ratio: .55 + ratio * .3 }) });
    const stage = new OffscreenCanvas(output.width, output.height);
    stage.getContext('2d').putImageData(new ImageData(scaled.pixels, output.width, output.height), 0, 0);

    onProgress?.({ jobId, phase: 'encode', ratio: 0.9 });
    const outputMime = resolveOutputMime(options, file);
    const { blob, mime, fallback } = await encodeResult(stage, output, outputMime);
    if (!blob || !Number.isFinite(blob.size)) {
      throw { code: 'ENCODE_FAILED', message: 'The encoder did not return a usable image.' };
    }

    return {
      blob,
      correction: meta.correction,
      meta: {
        presetId: meta.presetId,
        intensity: meta.intensity,
        styled: meta.styled,
        gradePath: meta.gradePath,
        adjustments: meta.adjustments ?? null,
        correction: meta.correction,
        histogram: histogramSummary(pixels),
        outputMime: blob.type || mime,
        outputFallback: Boolean(fallback),
        sourceMime: file.type || '',
        sourceBytes: file.size,
        bytes: blob.size,
        width: output.width,
        height: output.height,
        sourceWidth: width, sourceHeight: height,
        pixels: output.pixels,
        flatten: needsOpaqueBackdrop(blob.type || mime),
        filterPath: capabilityReport.filterPath,
      },
    };
  } catch (error) {
    throw toPlainError(error, signal, 'Enhancing failed for an unknown reason.');
  } finally {
    bitmap?.close?.();
    controllers.delete(jobId);
  }
}

/**
 * Measures the two grading paths against each other, on a deterministic ramp.
 *
 * Runs only when a page asks for it, once, and never blocks a job. Its purpose is to turn "the fallback
 * should look the same" into a number: a `maxDelta` that is not 0 means a browser without `ctx.filter`
 * is not rendering quite the same picture, and the tool can say so instead of implying it is identical.
 */
function selfTest() {
  if (capabilityReport.filterPath !== 'filter') {
    return { filterPath: capabilityReport.filterPath, maxDelta: null, measured: false };
  }
  const width = 32;
  const height = 8;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const value = (index * 7) % 256;
    pixels[index * 4] = value;
    pixels[index * 4 + 1] = (value * 3) % 256;
    pixels[index * 4 + 2] = 255 - value;
    pixels[index * 4 + 3] = 255;
  }

  const adjustments = { brightness: 1.07, contrast: 1.18, saturate: 1.35 };
  const filtered = gradeWithFilter(pixels, cssFilterFor(adjustments), width, height);
  const manual = applyFilterEquivalents(new Uint8ClampedArray(pixels), adjustments);
  let maxDelta = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(filtered[index] - manual[index]));
  }
  return { filterPath: capabilityReport.filterPath, maxDelta, measured: true, samples: pixels.length / 4 };
}

function cancel(jobId) {
  controllers.get(jobId)?.abort();
}

Comlink.expose({
  capabilities: () => ({ ...capabilityReport, previewWidth: PREVIEW_WIDTH, previewMime: PREVIEW_MIME }),
  previews,
  enhance,
  selfTest,
  cancel,
});
