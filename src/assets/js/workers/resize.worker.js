/**
 * Resize worker — the only file here that owns browser capabilities for this tool.
 *
 * Same contract as compress.worker.js, deliberately:
 *   capabilities()                                  -> { supported, missing[], resampler }
 *   resize({ jobId, file, options }, onProgress)     -> { blob, meta }
 *   cancel(jobId)                                   -> void
 *
 * `onProgress` is a separate top-level argument, for the same reason recorded in
 * compress.worker.js: comlink only wires top-level arguments, so a callback nested in the payload
 * object would be structurally cloned and throw instead of being proxied.
 *
 * Failures are thrown as plain serializeable `{ code, message }` objects, because structured
 * cloning drops custom properties off an Error subclass.
 *
 * Three decisions worth knowing:
 *
 *   - **pica runs with `features: ['js']`.** Its default feature list includes `ww`, which spawns
 *     a Worker *inside* this worker, needs a `workerURL` under a strict CSP, and is not supported
 *     everywhere. We are already off the main thread, so the pure-JS maths core is the right tool.
 *     `wasm` can be switched on later as a one-word change once it is shown to load cleanly under
 *     Vite; the capability report names which resampler is in use so the page can say so.
 *   - **`resizeBuffer` rather than `resize(canvas, canvas)`.** The documentation calls it
 *     "supplementary, not recommended for direct use" because it skips tiling, but that is exactly
 *     why it fits: no internal canvas, no nested workers, and raw RGBA is what we already have.
 *     The trade is peak memory, which `planResize` + the pixel budget bound before we start.
 *   - **`imageOrientation: 'from-image'`.** Without it, every phone photo taken in portrait is
 *     resized on its side. This is correct decoding, not EXIF stripping.
 *
 * Cancellation is checked between steps rather than mid-resample: `resizeBuffer` has no cancel
 * token, so a cancel during the resample takes effect at the next boundary.
 */
import * as Comlink from 'comlink';
import pica from 'pica';

import { CompressError, safeMaxPixels } from '../core/engine-compress.js';
import { encodeOptions, needsOpaqueBackdrop } from '../core/engine-convert.js';
import { assertResizeBudget, planResize } from '../core/engine-resize.js';

const controllers = new Map();
const capabilityReport = detectCapabilities();

function detectCapabilities() {
  const missing = [];
  if (typeof createImageBitmap !== 'function') missing.push('createImageBitmap');
  if (typeof OffscreenCanvas !== 'function') {
    missing.push('OffscreenCanvas');
    return { supported: false, missing, resampler: null };
  }
  const probe = new OffscreenCanvas(1, 1);
  if (typeof probe.getContext !== 'function') missing.push('OffscreenCanvas.getContext');
  if (typeof probe.convertToBlob !== 'function') missing.push('OffscreenCanvas.convertToBlob');
  return { supported: missing.length === 0, missing, resampler: 'pica (pure JS)' };
}

let resizer = null;

function getResizer() {
  if (!resizer) resizer = pica({ features: ['js'] });
  return resizer;
}

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw { code: 'DECODE_FAILED', message: 'That file could not be decoded as an image.' };
  }
}

function throwIfAborted(signal) {
  if (signal.aborted) throw { code: 'ABORTED', message: 'Resizing was cancelled.' };
}

/** Draws a bitmap into a fresh canvas, filling white first when the output format needs it. */
function canvasFrom(bitmap, width, height, { backdrop = false } = {}) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (backdrop) {
    // Filling first only helps because the resampled pixels are drawn *onto* it: putImageData
    // would replace the fill (and with it the alpha) rather than composite over it.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

async function resample(bitmap, plan) {
  const source = new OffscreenCanvas(bitmap.width, bitmap.height);
  source.getContext('2d').drawImage(bitmap, 0, 0);
  const { data } = source.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height);

  const resized = await getResizer().resizeBuffer({
    src: data,
    width: bitmap.width,
    height: bitmap.height,
    toWidth: plan.width,
    toHeight: plan.height,
  });

  const clamped = new Uint8ClampedArray(resized.length);
  clamped.set(resized);
  const stage = new OffscreenCanvas(plan.width, plan.height);
  stage.getContext('2d').putImageData(new ImageData(clamped, plan.width, plan.height), 0, 0);
  return stage;
}

async function resize(payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  if (!capabilityReport.supported) {
    throw {
      code: 'UNSUPPORTED',
      message: `This browser is missing ${capabilityReport.missing.join(', ')}, so images cannot be resized on your device here.`,
    };
  }
  if (!jobId) throw { code: 'INVALID_JOB', message: 'A resize job needs an id.' };
  if (!file || file.size === 0) throw { code: 'INVALID_INPUT', message: 'No image file was provided.' };

  const controller = new AbortController();
  controllers.set(jobId, controller);
  const { signal } = controller;

  try {
    onProgress?.({ jobId, phase: 'probe', ratio: 0.05 });

    const bitmap = await decode(file);
    throwIfAborted(signal);

    // The budget is the platform's own canvas limit, and it applies to the source as well as the
    // result: reading the pixels back for the resampler allocates a canvas at the full source size.
    const budget = safeMaxPixels(options.maxPixels, navigator.userAgent);
    assertResizeBudget(bitmap.width, bitmap.height, budget);

    const plan = planResize({
      sourceWidth: bitmap.width,
      sourceHeight: bitmap.height,
      targetWidth: options.width ?? null,
      targetHeight: options.height ?? null,
      lockAspect: options.lockAspect !== false,
      allowUpscale: Boolean(options.allowUpscale),
    });

    const outputMime = options.outputMime || 'image/webp';
    const backdrop = needsOpaqueBackdrop(outputMime);
    assertResizeBudget(plan.width, plan.height, budget);

    onProgress?.({ jobId, phase: 'resize', ratio: 0.55 });

    // A format change with no size change still has to go through a canvas, but it must not be
    // resampled: scaling to the identical size costs time and loses a little sharpness.
    const canvas = plan.scaled
      ? await resample(bitmap, plan)
      : canvasFrom(bitmap, plan.width, plan.height);
    throwIfAborted(signal);

    // Flattening happens on a second canvas so the transparent pixels composite onto white
    // instead of being replaced by it.
    const output = backdrop ? canvasFrom(canvas, plan.width, plan.height, { backdrop: true }) : canvas;

    // Captured before close(): close() detaches the bitmap and its width/height then read back as
    // 0, which is what made the result readout say "0×0 → 500×350".
    const source = { width: bitmap.width, height: bitmap.height };

    onProgress?.({ jobId, phase: 'encode', ratio: 0.9 });
    const blob = await output.convertToBlob(encodeOptions({ mime: outputMime }));
    bitmap.close?.();

    if (!blob || !Number.isFinite(blob.size)) {
      throw { code: 'ENCODE_FAILED', message: 'The encoder did not return a usable image.' };
    }

    return {
      blob,
      meta: {
        outputMime: blob.type || outputMime,
        sourceBytes: file.size,
        sourceWidth: source.width,
        sourceHeight: source.height,
        width: plan.width,
        height: plan.height,
        scaled: plan.scaled,
        ratio: plan.ratio,
        flatten: backdrop,
        bytes: blob.size,
        resampler: capabilityReport.resampler,
      },
    };
  } catch (error) {
    if (error instanceof CompressError) throw { code: error.code, message: error.message };
    if (signal.aborted) throw { code: 'ABORTED', message: 'Resizing was cancelled.' };
    if (error && typeof error.code === 'string') throw error;
    throw { code: 'INTERNAL', message: error?.message || 'Resizing failed for an unknown reason.' };
  } finally {
    controllers.delete(jobId);
  }
}

function cancel(jobId) {
  controllers.get(jobId)?.abort();
}

Comlink.expose({ capabilities: () => capabilityReport, resize, cancel });
