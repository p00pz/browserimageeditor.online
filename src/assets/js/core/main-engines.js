import { upscalePixels, upscaleSize } from './upscale.js';
import { createPdf } from './pdf-document.js';
/**
 * The main-thread engine implementations.
 *
 * This module is dynamically imported by worker-or-main.js ONLY when a browser cannot run the
 * engines in a Web Worker — Safari before 16.4 has no OffscreenCanvas inside a worker, so on
 * those devices the worker answers `supported: false` and the main thread takes over. Every
 * other browser never fetches this file, which keeps `browser-image-compression`, `pica` and
 * `pdf-lib` out of the bundle a modern browser downloads at all.
 *
 * The implementations mirror the RPC surface each worker exposes (see the workers'
 * `Comlink.expose`) and reuse the same `core/engine-*.js` planning and pixel logic, so a result
 * is byte-comparable with the worker's. The two browser APIs the workers had are supplied with
 * `document.createElement('canvas')` + `toBlob` and main-thread `createImageBitmap`; pixel
 * passes are banded so the thread is handed back between them.
 */

import { CompressError, compressFile, safeMaxPixels, assertPixelBudget } from './engine-compress.js';
import { availableFormats, encodeOptions, needsOpaqueBackdrop, planConversion } from './engine-convert.js';
import { CANVAS_OUTPUT_FORMATS, isHeicFile } from './formats.js';
import { assertResizeBudget, planResize } from './engine-resize.js';
import {
  AUTO_PRESET_ID,
  DEFAULT_PRESET_ID,
  ENHANCE_PRESETS,
  applyAutoLut,
  applyFilterEquivalents,
  applyGrade,
  applySharpenDelta,
  blendPixels,
  boxBlurCols,
  boxBlurRows,
  buildAutoLut,
  composeAdvanced,
  cssFilterFor,
  enhancePixels,
  extractLuma,
  hasManualWork,
  histogramChannels,
  intensityOf,
  isNeutralAdvanced,
  presetById,
  assertEnhanceBudget,
} from './engine-enhance.js';
import { embedStrategy, findQuality, planPage, toPdfBox } from './engine-pdf.js';

const ABORTED_MESSAGE = 'The job was cancelled.';

/**
 * The honest name for the resize path this engine uses on the main thread.
 *
 * The worker resamples with pica's pure-JS core because it is already off-thread. On the main
 * thread the browser's own canvas resampling is the right tool: it is the GPU's, it costs
 * milliseconds rather than seconds, and it is what keeps the page responsive. `meta.resampler`
 * says which one ran, so a result never claims a resampler it did not use.
 */
const RESAMPLER_MAIN = 'canvas (main thread)';

/**
 * How many row bands a pixel pass is split into. More bands means more yields and less time per
 * band; sixty-four keeps a 12 MP photograph's per-band work in the neighbourhood of one frame.
 */
const BAND_COUNT = 64;

/** A frame's worth of milliseconds, after which a band loop yields to the main thread. */
const FRAME_BUDGET_MS = 12;
const PREVIEW_WIDTH = 160;
const PREVIEW_MIME = 'image/jpeg';
const PREVIEW_QUALITY = 0.92;
const FALLBACK_OUTPUT_MIME = 'image/jpeg';
const OUTPUT_QUALITY = 0.95;

/* ---------- the two browser APIs the workers had, main-thread editions ---------- */

function now() {
  return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function domCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Drops a canvas's backing store, the way the workers drop an OffscreenCanvas they are done with. */
function discardCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function canvasToBlob(canvas, { type, quality } = {}) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject({ code: 'ENCODE_FAILED', message: 'The encoder did not return a usable image.' }),
      type,
      quality,
    );
  });
}

/**
 * Decodes to a bitmap the same way every worker does.
 *
 * `imageOrientation: 'from-image'` is not decoration: a phone photo stored sideways decodes
 * upright, so the pixel budget and every reported dimension describe the picture the visitor sees.
 */
async function decodeBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw { code: 'DECODE_FAILED', message: 'That file could not be decoded as an image.' };
  }
}

/**
 * Decodes to a bitmap with the browser's own decoder, and reports which route was used.
 *
 * The main-thread engine deliberately has no software HEIC fallback, though the worker has one.
 * `heic-to` is 2.9 MB, and importing it here would emit a second copy of that chunk alongside the
 * worker's own — the two module graphs cannot share it. The main-thread path only runs at all on a
 * browser whose worker lacks `OffscreenCanvas`, which in practice is WebKit, and WebKit decodes
 * HEIC natively; everywhere else the worker path runs and keeps its decoder. A HEIC this browser
 * cannot read is reported as undecodable rather than silently fetching a megabyte of WASM.
 */
async function decodeToBitmap(file) {
  try {
    return { bitmap: await createImageBitmap(file, { imageOrientation: 'from-image' }), route: 'native' };
  } catch {
    throw { code: 'DECODE_FAILED', message: 'That file could not be decoded as an image.' };
  }
}

/**
 * Draws an image source into a fresh DOM canvas, filling white first when the output format needs
 * it. The mirror of the workers' `drawTo()`, including the reason the fill comes before the draw.
 */
function drawToMain(width, height, source, { backdrop = false, smoothing = 'low', filter = 'none' } = {}) {
  const canvas = domCanvas(width, height);
  const context = canvas.getContext('2d');
  if (backdrop) {
    // Filling first only helps because the pixels are drawn *onto* it: putImageData would replace
    // the fill (and with it the alpha) rather than composite over it.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.imageSmoothingQuality = smoothing;
  if (filter !== 'none') context.filter = filter;
  context.drawImage(source, 0, 0, width, height);
  context.filter = 'none';
  return canvas;
}

/* ---------- never freezing, and cancelling while at it ---------- */

/** Yields to the main thread so a frame can be painted and a tap can land. */
function yieldToMain() {
  return new Promise((resolve) => setTimeout(resolve));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw { code: 'ABORTED', message: ABORTED_MESSAGE };
}

/**
 * Walks a plane's rows in bands, awaiting `work(y0, y1)` for each and yielding to the main thread
 * whenever a frame's worth of time has been spent.
 *
 * The abort check runs *between* bands rather than inside the pixel loops, which is what makes a
 * cancel real on the main thread: the loop is already broken into pieces, so the signal is read at
 * a boundary the work itself already crosses.
 */
async function forEachRowBand(height, work, { signal } = {}) {
  const band = Math.max(1, Math.ceil(height / BAND_COUNT));
  let spent = now();
  for (let y = 0; y < height; y += band) {
    throwIfAborted(signal);
    await work(y, Math.min(height, y + band));
    if (now() - spent >= FRAME_BUDGET_MS) {
      await yieldToMain();
      spent = now();
    }
  }
}

/** A view of `plane`'s rows `[y0, y1)`, as RGBA bytes. */
function planeRows(plane, width, y0, y1) {
  return plane.subarray(y0 * width * 4, y1 * width * 4);
}

/**
 * One error becomes one plain `{ code, message }`, exactly as it arrives from a worker.
 *
 * The tools' `normalizeRejection()` looks for that shape; keeping it means no tool has to learn
 * which side of the engine boundary an error came from.
 */
function toPlainError(error, signal, fallback) {
  if (error instanceof CompressError) return { code: error.code, message: error.message };
  if (error && typeof error.code === 'string') return error;
  if (signal?.aborted || error?.name === 'AbortError') return { code: 'ABORTED', message: ABORTED_MESSAGE };
  if (error instanceof RangeError || /allocation|memory|too large/i.test(error?.message ?? '')) {
    return {
      code: 'IMAGE_TOO_LARGE',
      message: 'This image was too large to process on this device. Try a smaller photo, or a desktop browser.',
    };
  }
  return { code: 'INTERNAL', message: error?.message || fallback };
}

function unsupportedError(missing, verb) {
  return {
    code: 'UNSUPPORTED',
    message: `This browser is missing ${missing.join(', ')}, so images cannot be ${verb} on your device here.`,
  };
}

/* ---------- what the main thread can actually do ---------- */

/**
 * The two APIs the main-thread engines need. `createImageBitmap` is the one a modern browser could
 * plausibly be without, and a DOM canvas without `toBlob` cannot write anything, so both are asked
 * rather than assumed — the answer decides whether the tool stays honestly unsupported.
 */
function detectMainMissing() {
  const missing = [];
  if (typeof createImageBitmap !== 'function') missing.push('createImageBitmap');
  if (typeof document !== 'object' || typeof document?.createElement !== 'function') {
    missing.push('document.createElement');
    return missing;
  }
  const probe = document.createElement('canvas');
  if (typeof probe.getContext !== 'function') missing.push('canvas.getContext');
  else if (typeof probe.toBlob !== 'function') missing.push('canvas.toBlob');
  probe.width = 0;
  probe.height = 0;
  return missing;
}

function mainSupported() {
  return detectMainMissing().length === 0;
}

/** Whether this engine's 2D context honours `ctx.filter`, probed once and remembered. */
let mainFilterPath = null;
function detectFilterPathMain() {
  if (mainFilterPath !== null) return mainFilterPath;
  if (!mainSupported()) return (mainFilterPath = 'none');
  try {
    const probe = domCanvas(1, 1);
    const context = probe.getContext('2d');
    if (!context) return (mainFilterPath = 'none');
    context.filter = 'brightness(0.5)';
    const accepted = context.filter === 'brightness(0.5)';
    context.filter = 'none';
    discardCanvas(probe);
    return (mainFilterPath = accepted ? 'filter' : 'manual');
  } catch {
    return (mainFilterPath = 'manual');
  }
}

/** The `deps.gradeWithFilter` the engine expects: the GPU step, on a DOM canvas. */
function gradeWithFilterMain(pixels, filter, width, height) {
  const source = domCanvas(width, height);
  source.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  const target = domCanvas(width, height);
  const context = target.getContext('2d');
  // Smoothing is off because the draw is 1:1; any smoothing would be a resample nobody asked for.
  context.imageSmoothingEnabled = false;
  context.filter = filter;
  context.drawImage(source, 0, 0);
  context.filter = 'none';
  const data = new Uint8ClampedArray(context.getImageData(0, 0, width, height).data);
  discardCanvas(source);
  discardCanvas(target);
  return data;
}

/** The `deps` object `enhancePixels()` expects for a plane of the given size. */
function engineDepsMain(width, height) {
  if (detectFilterPathMain() !== 'filter') return { width };
  return {
    width,
    gradeWithFilter: (pixels, filter) => gradeWithFilterMain(pixels, filter, width, height),
  };
}

/**
 * Encodes a 1×1 canvas and reads the type back, because `toBlob({ type: 'image/avif' })`
 * cheerfully returns a PNG in browsers that never learned AVIF. Whatever the probe rejects is never
 * offered, exactly as in the convert worker.
 */
async function canEncodeMain(mime) {
  try {
    const canvas = domCanvas(1, 1);
    const context = canvas.getContext('2d');
    // The pixel drawn before the encode is not decoration: a context-less canvas throws in Chrome,
    // which would report "cannot write the format" for every type.
    context.fillRect(0, 0, 1, 1);
    const blob = await canvasToBlob(canvas, { type: mime });
    discardCanvas(canvas);
    return blob?.type === mime;
  } catch {
    return false;
  }
}

/* ---------- compress ---------- */

async function probeSizeMain(file) {
  const bitmap = await decodeBitmap(file);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close?.();
  }
}

async function compressMain(state, payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  if (!mainSupported()) throw unsupportedError(detectMainMissing(), 'compressed');
  if (!jobId) throw { code: 'INVALID_JOB', message: 'A compression job needs an id.' };

  const controller = new AbortController();
  state.controllers.set(jobId, controller);

  try {
    // The compress worker's own encoder, fetched only when a main-thread compress actually runs.
    // It already falls back to a DOM canvas when `OffscreenCanvas` is absent, which is the case
    // that brought us here.
    const { default: imageCompression } = await import('browser-image-compression');
    // Yields before the probe and before every quality attempt of the target-size search, so the
    // search's encodes each start from a responsive page rather than chaining into one another.
    const yieldBefore = async (value) => {
      await yieldToMain();
      return value;
    };
    return await compressFile(
      file,
      {
        ...options,
        signal: controller.signal,
        onProgress: (update) => onProgress?.({ jobId, ...update }),
        // The canvas area a browser can allocate is decided by the platform; the engine's pixel
        // budget has to match it, and the main thread is where the user agent is visible.
        userAgent: navigator.userAgent,
      },
      {
        imageCompression: (fileArg, libraryOptions) => yieldBefore(imageCompression(fileArg, libraryOptions)),
        probeSize: (fileArg) => yieldBefore(probeSizeMain(fileArg)),
      },
    );
  } catch (error) {
    throw toPlainError(error, controller.signal, 'Compression failed for an unknown reason.');
  } finally {
    state.controllers.delete(jobId);
  }
}

/* ---------- resize ---------- */

async function resizeMain(state, payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  if (!mainSupported()) throw unsupportedError(detectMainMissing(), 'resized');
  if (!jobId) throw { code: 'INVALID_JOB', message: 'A resize job needs an id.' };
  if (!file || file.size === 0) throw { code: 'INVALID_INPUT', message: 'No image file was provided.' };

  const controller = new AbortController();
  state.controllers.set(jobId, controller);
  const { signal } = controller;

  try {
    onProgress?.({ jobId, phase: 'probe', ratio: 0.05 });
    const bitmap = await decodeBitmap(file);
    throwIfAborted(signal);

    // The budget applies to the source as well as the result: a canvas at the full source size is
    // what a resample reads from. It is the platform's own limit, not a policy number.
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
    await yieldToMain();

    const canvas = domCanvas(plan.width, plan.height);
    const context = canvas.getContext('2d');
    if (backdrop) {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, plan.width, plan.height);
    }
    // A format change with no size change must not be resampled, so smoothing is only armed when
    // the plan actually scaled — the same rule the worker's `canvasFrom`/`resample` split enforces.
    context.imageSmoothingEnabled = plan.scaled;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, plan.width, plan.height);

    // Captured before close(): a closed bitmap reports 0×0, which is what made the result readout
    // say "0×0 → 500×350" once.
    const source = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    throwIfAborted(signal);

    onProgress?.({ jobId, phase: 'encode', ratio: 0.9 });
    const blob = await canvasToBlob(canvas, encodeOptions({ mime: outputMime }));
    discardCanvas(canvas);
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
        resampler: RESAMPLER_MAIN,
      },
    };
  } catch (error) {
    if (error instanceof CompressError) throw { code: error.code, message: error.message };
    if (signal.aborted) throw { code: 'ABORTED', message: ABORTED_MESSAGE };
    if (error && typeof error.code === 'string') throw error;
    throw { code: 'INTERNAL', message: error?.message || 'Resizing failed for an unknown reason.' };
  } finally {
    state.controllers.delete(jobId);
  }
}

/* ---------- convert (also the crop tool's encoder) ---------- */

let convertCapabilityPromise = null;

/** Probed once, lazily, and remembered — the convert tool's format list is built from this answer. */
function convertCapabilitiesMain() {
  if (!convertCapabilityPromise) {
    convertCapabilityPromise = (async () => {
      const missing = detectMainMissing();
      if (missing.length > 0) {
        return { supported: false, missing, mode: 'main-thread', encodable: [], heic: null };
      }
      const encodable = [];
      for (const mime of CANVAS_OUTPUT_FORMATS) {
        if (await canEncodeMain(mime)) encodable.push(mime);
      }
      // `native` stays null: there is no cheap way to ask whether this browser reads HEIC without a
      // HEIC to try, so the answer is discovered by trying. The page's copy says "on your device",
      // which is true either way.
      return {
        supported: true,
        missing,
        mode: 'main-thread',
        encodable,
        heic: { native: null, decoder: true },
      };
    })();
  }
  return convertCapabilityPromise;
}

async function convertMain(state, payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  const report = await convertCapabilitiesMain();
  if (!report.supported) throw unsupportedError(report.missing, 'converted');
  if (!jobId) throw { code: 'INVALID_JOB', message: 'A conversion job needs an id.' };
  if (!file || file.size === 0) throw { code: 'INVALID_INPUT', message: 'No image file was provided.' };

  const controller = new AbortController();
  state.controllers.set(jobId, controller);
  const { signal } = controller;

  try {
    onProgress?.({ jobId, phase: 'probe', ratio: 0.1 });

    const plan = planConversion({
      file,
      requested: options.outputMime ?? null,
      supported: report.encodable,
    });

    const { bitmap, route } = await decodeToBitmap(file);
    if (signal.aborted) throw { code: 'ABORTED', message: ABORTED_MESSAGE };

    const size = { width: bitmap.width, height: bitmap.height };

    // Checked before the output canvas is allocated, because allocating it *is* what runs the
    // device out of memory on a huge photo.
    assertPixelBudget(size.width, size.height, safeMaxPixels(options.maxPixels, navigator.userAgent));

    onProgress?.({ jobId, phase: 'encode', ratio: 0.6 });
    await yieldToMain();

    const canvas = domCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    if (plan.needsBackdrop) {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, size.width, size.height);
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    const blob = await canvasToBlob(
      canvas,
      encodeOptions({ mime: plan.mime, quality: options.quality ?? plan.quality }),
    );
    discardCanvas(canvas);
    if (!blob || !Number.isFinite(blob.size)) {
      throw { code: 'ENCODE_FAILED', message: 'The encoder did not return a usable image.' };
    }
    if (blob.type !== plan.mime) {
      // The probe said this format works, so a mismatch means something changed under us. Better a
      // clear failure than a file in a format nobody asked for.
      throw {
        code: 'ENCODE_FAILED',
        message: `This browser could not write ${plan.mime}; it produced ${blob.type || 'an unknown format'} instead.`,
      };
    }

    onProgress?.({ jobId, phase: 'encode', ratio: 1 });

    return {
      blob,
      meta: {
        outputMime: plan.mime,
        sourceBytes: file.size,
        sourceType: file.type || null,
        sourceWidth: size.width,
        sourceHeight: size.height,
        width: size.width,
        height: size.height,
        scaled: false,
        flatten: plan.needsBackdrop,
        quality: plan.quality,
        bytes: blob.size,
        decodeRoute: route,
        note: plan.note,
      },
    };
  } catch (error) {
    if (error instanceof CompressError) throw { code: error.code, message: error.message };
    if (signal.aborted) throw { code: 'ABORTED', message: ABORTED_MESSAGE };
    if (error && typeof error.code === 'string') throw error;
    throw { code: 'INTERNAL', message: error?.message || 'Conversion failed for an unknown reason.' };
  } finally {
    state.controllers.delete(jobId);
  }
}

/* ---------- enhance ---------- */

/** What a photo is re-encoded as when its own format cannot be written back (HEIC or AVIF input). */
function resolveOutputMimeMain(options, file) {
  const requested = options.outputMime;
  if (typeof requested === 'string' && requested.startsWith('image/')) return requested;
  const own = file?.type;
  const decodable = typeof own === 'string' && own.startsWith('image/');
  if (decodable && own !== 'image/heic' && own !== 'image/heif' && own !== 'image/avif') return own;
  return FALLBACK_OUTPUT_MIME;
}

/**
 * The before-numbers the result panel reports, read off the histograms the correction itself was
 * computed from. The worker's `histogramSummary()` over the same plane; the numbers are identical
 * because they come from the same accumulated bins.
 */
function histogramSummaryMain(histograms) {
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

/** Encodes the graded stage, flattening onto white when the format cannot store alpha. */
async function encodeResultMain(stage, { width, height }, mime) {
  const needsBackdrop = needsOpaqueBackdrop(mime);
  const target = needsBackdrop ? drawToMain(width, height, stage, { backdrop: true }) : stage;
  try {
    return {
      blob: await canvasToBlob(
        target,
        encodeOptions({ mime, quality: mime === 'image/png' ? undefined : OUTPUT_QUALITY }),
      ),
      mime,
    };
  } catch (error) {
    // The retry cannot silently misreport itself: the returned `mime` on the fallback path is the
    // fallback, and the blob's own type is what the result panel prints.
    if (mime === 'image/png') throw error;
    const retry = drawToMain(width, height, stage);
    try {
      return {
        blob: await canvasToBlob(retry, encodeOptions({ mime: 'image/png' })),
        mime: 'image/png',
        fallback: true,
      };
    } finally {
      discardCanvas(retry);
    }
  } finally {
    if (needsBackdrop) discardCanvas(target);
  }
}

/**
 * The unsharp mask in row bands, reusing the engine's own separable passes.
 *
 * `sharpenPixels()` is three steps — extract a luma plane, blur it, add the delta back — and only
 * the blur's vertical half needs more than one row at a time. So the plane is walked band by band
 * three times: luma and the horizontal blur together (each output row needs only its own input
 * row), the vertical blur with `radius` rows of overlap, then the delta. No step is re-implemented;
 * each is the exported engine function, applied to a band.
 */
async function sharpenBandedMain(plane, width, height, sharpen, { signal }) {
  const radius = Math.max(1, Math.round(sharpen.radius ?? 1));
  const amount = sharpen.amount ?? 0;
  if (!(amount > 0)) return;

  const luma = new Uint8Array(width * height);
  const horizontal = new Uint8Array(width * height);
  const blurred = new Uint8Array(width * height);

  await forEachRowBand(
    height,
    (y0, y1) => {
      const bandLuma = extractLuma(planeRows(plane, width, y0, y1));
      luma.set(bandLuma, y0 * width);
      horizontal.set(boxBlurRows(bandLuma, width, radius), y0 * width);
    },
    { signal },
  );

  await forEachRowBand(
    height,
    (y0, y1) => {
      // A vertical blur at row y reads rows y−r…y+r, so the band is widened by the radius and the
      // rows that belong to the neighbour band are discarded rather than written twice.
      const start = Math.max(0, y0 - radius);
      const end = Math.min(height, y1 + radius);
      const cols = boxBlurCols(horizontal.subarray(start * width, end * width), width, radius);
      blurred.set(
        cols.subarray((y0 - start) * width, (y0 - start + (y1 - y0)) * width),
        y0 * width,
      );
    },
    { signal },
  );

  await forEachRowBand(
    height,
    (y0, y1) => {
      applySharpenDelta(
        planeRows(plane, width, y0, y1),
        luma.subarray(y0 * width, y1 * width),
        blurred.subarray(y0 * width, y1 * width),
        amount,
      );
    },
    { signal },
  );
}

function assertUsableMain({ jobId, file }, verb) {
  if (!mainSupported()) throw unsupportedError(detectMainMissing(), verb);
  if (!jobId) throw { code: 'INVALID_JOB', message: 'An enhance job needs an id.' };
  if (!file || file.size === 0) throw { code: 'INVALID_INPUT', message: 'No image file was provided.' };
}

/**
 * The full two-stage pipeline, in bands, on the main thread.
 *
 * Stage A's histogram has to see every pixel before its LUT exists, so the plane is read once, band
 * by band, accumulating histograms as it goes. Everything after that — the correction, the grade,
 * the intensity blend, the sharpening, and the write-back — is per-row or per-band, and each yields.
 */
async function enhanceMain(state, payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  assertUsableMain(payload, 'enhanced');

  const controller = new AbortController();
  state.controllers.set(jobId, controller);
  const { signal } = controller;

  let bitmap = null;
  try {
    onProgress?.({ jobId, phase: 'probe', ratio: 0.05 });
    bitmap = await decodeBitmap(file);
    throwIfAborted(signal);

    // The budget is the platform's own canvas limit: an iPhone photo past it cannot be held on a
    // canvas here at all, so it is refused with a reason rather than crashing mid-pipeline.
    const budget = assertEnhanceBudget(bitmap.width, bitmap.height, safeMaxPixels(options.maxPixels, navigator.userAgent));
    const { width, height } = budget;
    const output = upscaleSize(width, height, options.scale ?? 1, Math.min(16000000, safeMaxPixels(options.maxPixels, navigator.userAgent)));

    onProgress?.({ jobId, phase: 'analyse', ratio: 0.2 });

    // One canvas holds the decoded photo; the plane is filled from it in reads small enough to
    // cost a few milliseconds rather than a few hundred.
    const source = drawToMain(width, height, bitmap);
    const context = source.getContext('2d');
    const plane = new Uint8ClampedArray(width * height * 4);
    const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    await forEachRowBand(
      height,
      (y0, y1) => {
        const band = context.getImageData(0, y0, width, y1 - y0);
        plane.set(band.data, y0 * width * 4);
        // The engine's own histogram, per band, accumulated into the page's three bins.
        const bandHistograms = histogramChannels(band.data);
        for (let channel = 0; channel < 3; channel += 1) {
          const accumulated = histograms[channel];
          const bandHistogram = bandHistograms[channel];
          for (let bin = 0; bin < 256; bin += 1) accumulated[bin] += bandHistogram[bin];
        }
      },
      { signal },
    );
    discardCanvas(source);
    bitmap.close?.();
    bitmap = null;

    // Stage A: one LUT from the complete histograms, and the before-numbers from the same bins.
    const { lut, stats: correction } = buildAutoLut(histograms);
    const before = histogramSummaryMain(histograms);

    // Stage B's recipe, resolved exactly as the engine resolves it.
    const autoOnly = options.presetId === AUTO_PRESET_ID;
    const preset = autoOnly ? { id: AUTO_PRESET_ID, adjustments: {} } : presetById(options.presetId ?? DEFAULT_PRESET_ID);
    const adjustments = composeAdvanced(preset.adjustments, isNeutralAdvanced(options.advanced) ? null : options.advanced);
    const filter = cssFilterFor(adjustments);
    const intensity = autoOnly ? 1 : intensityOf(options.intensity);

    // Auto with neutral Advanced, or a preset dialled to 0 %: both are the auto-corrected image,
    // and neither should be pushed through a single extra arithmetic step.
    const needsGrade = intensity !== 0 && (filter !== '' || hasManualWork(adjustments));
    const gradePath = needsGrade
      ? detectFilterPathMain() === 'filter' && filter !== ''
        ? 'filter'
        : 'manual'
      : 'none';

    const graded = new Uint8ClampedArray(plane.length);
    if (needsGrade) onProgress?.({ jobId, phase: 'grade', ratio: 0.4 });

    await forEachRowBand(
      height,
      (y0, y1) => {
        const rows = y1 - y0;
        // A copy, because the engine copies before it writes and the plane is the before-plane.
        const base = new Uint8ClampedArray(planeRows(plane, width, y0, y1));
        applyAutoLut(base, lut, correction);
        let out = base;
        if (needsGrade) {
          // Sharpening is stripped from the band pass: a blur is not a per-row operation, so it
          // runs as its own banded pass below. Everything else in `applyGrade` is.
          const styled = applyGrade(base, { ...adjustments, sharpen: undefined }, engineDepsMain(width, rows));
          out = intensity === 1 ? styled : blendPixels(base, styled, intensity);
        }
        graded.set(out, y0 * width * 4);
      },
      { signal },
    );

    if (needsGrade && adjustments.sharpen) {
      await sharpenBandedMain(graded, width, height, adjustments.sharpen, { signal });
    }

    const scaled = await upscalePixels(graded, width, height, output.scale, { signal,
      onProgress: (ratio) => onProgress?.({ jobId, phase: 'upscale', ratio: .55 + ratio * .3 }) });
    const stage = domCanvas(output.width, output.height);
    stage.getContext('2d').putImageData(new ImageData(scaled.pixels, output.width, output.height), 0, 0);

    onProgress?.({ jobId, phase: 'encode', ratio: 0.9 });
    const outputMime = resolveOutputMimeMain(options, file);
    let encoded;
    try {
      encoded = await encodeResultMain(stage, output, outputMime);
    } finally {
      discardCanvas(stage);
    }
    const { blob, mime, fallback } = encoded;
    if (!blob || !Number.isFinite(blob.size)) {
      throw { code: 'ENCODE_FAILED', message: 'The encoder did not return a usable image.' };
    }

    return {
      blob,
      correction,
      meta: {
        presetId: autoOnly ? AUTO_PRESET_ID : options.presetId ?? DEFAULT_PRESET_ID,
        intensity,
        styled: needsGrade,
        gradePath,
        ...(needsGrade ? { adjustments } : null),
        correction,
        histogram: before,
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
        filterPath: detectFilterPathMain(),
      },
    };
  } catch (error) {
    throw toPlainError(error, signal, 'Enhancing failed for an unknown reason.');
  } finally {
    bitmap?.close?.();
    state.controllers.delete(jobId);
  }
}

/**
 * The thumbnail row: one decode, one downscale, five grades — the worker's `previews()` in full.
 *
 * A 160px-wide plane is ~25k pixels, so the whole `enhancePixels()` runs on it directly. Banding
 * here would cost more in setup than it saves in frames.
 */
async function previewsMain(state, payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  assertUsableMain(payload, 'enhanced');

  const controller = new AbortController();
  state.controllers.set(jobId, controller);
  const { signal } = controller;

  let bitmap = null;
  try {
    onProgress?.({ jobId, phase: 'probe', ratio: 0.05 });
    bitmap = await decodeBitmap(file);
    throwIfAborted(signal);

    const width = Math.max(1, Math.min(options.previewWidth || PREVIEW_WIDTH, bitmap.width));
    const height = Math.max(1, Math.round((bitmap.height / bitmap.width) * width));
    const small = drawToMain(width, height, bitmap, { backdrop: true, smoothing: 'high' });
    const pixels = new Uint8ClampedArray(small.getContext('2d').getImageData(0, 0, width, height).data);
    discardCanvas(small);
    const deps = engineDepsMain(width, height);

    const items = [];
    let correction = null;
    for (let index = 0; index < ENHANCE_PRESETS.length; index += 1) {
      throwIfAborted(signal);
      const preset = ENHANCE_PRESETS[index];
      // The engine copies before it writes, so `pixels` is still the ungraded plane each time round
      // — every preset gets its own auto-correct, none inherits the previous one's output.
      const { pixels: graded, meta } = enhancePixels(pixels, { presetId: preset.id, intensity: 1 }, deps);
      correction ??= meta.correction;

      const canvas = domCanvas(width, height);
      canvas.getContext('2d').putImageData(new ImageData(graded, width, height), 0, 0);
      items.push({
        presetId: preset.id,
        blob: await canvasToBlob(canvas, encodeOptions({ mime: PREVIEW_MIME, quality: PREVIEW_QUALITY })),
      });
      discardCanvas(canvas);
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
      filterPath: detectFilterPathMain(),
    };
  } catch (error) {
    throw toPlainError(error, signal, 'The previews could not be generated.');
  } finally {
    bitmap?.close?.();
    state.controllers.delete(jobId);
  }
}

/** Measures the two grading paths against each other, on the same deterministic ramp as the worker. */
function selfTestMain() {
  const filterPath = detectFilterPathMain();
  if (filterPath !== 'filter') {
    return { filterPath, maxDelta: null, measured: false };
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
  const filtered = gradeWithFilterMain(pixels, cssFilterFor(adjustments), width, height);
  const manual = applyFilterEquivalents(new Uint8ClampedArray(pixels), adjustments);
  let maxDelta = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(filtered[index] - manual[index]));
  }
  return { filterPath, maxDelta, measured: true, samples: pixels.length / 4 };
}

/* ---------- image to PDF ---------- */

async function encodePageMain(state, payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  if (!mainSupported()) throw unsupportedError(detectMainMissing(), 'placed in a PDF');
  if (!jobId) throw { code: 'INVALID_JOB', message: 'A page needs a job id.' };
  if (!file || file.size === 0) throw { code: 'INVALID_INPUT', message: 'No image file was provided.' };

  const controller = new AbortController();
  state.controllers.set(jobId, controller);
  const { signal } = controller;

  try {
    onProgress?.({ jobId, phase: 'probe', ratio: 0.2 });
    const bitmap = await decodeBitmap(file);
    if (signal.aborted) throw { code: 'ABORTED', message: 'Building the PDF was cancelled.' };

    // PNG passes straight through; everything else is redrawn as JPEG, because pdf-lib embeds a
    // JPEG byte-for-byte with its EXIF orientation, so a portrait phone photo would land on its
    // side. Redrawing applies the orientation the browser decoded with.
    const strategy = embedStrategy(file.type);
    let bytes;
    let mime;

    if (strategy === 'passthrough') {
      bytes = new Uint8Array(await file.arrayBuffer());
      mime = 'image/png';
    } else {
      const quality = findQuality(options.qualityId)?.quality ?? 0.85;
      const canvas = domCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      // JPEG has no alpha channel; without this the transparent pixels composite to black.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, bitmap.width, bitmap.height);
      context.drawImage(bitmap, 0, 0);
      onProgress?.({ jobId, phase: 'encode', ratio: 0.7 });
      const blob = await canvasToBlob(canvas, encodeOptions({ mime: 'image/jpeg', quality }));
      discardCanvas(canvas);
      if (!blob || blob.type !== 'image/jpeg') {
        throw { code: 'ENCODE_FAILED', message: 'This browser could not encode a page image.' };
      }
      bytes = new Uint8Array(await blob.arrayBuffer());
      mime = 'image/jpeg';
    }

    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    onProgress?.({ jobId, phase: 'encode', ratio: 1 });

    return {
      bytes,
      mime,
      width: dimensions.width,
      height: dimensions.height,
      strategy,
      bytesLength: bytes.byteLength,
    };
  } catch (error) {
    if (error instanceof CompressError) throw { code: error.code, message: error.message };
    if (signal.aborted) throw { code: 'ABORTED', message: 'Building the PDF was cancelled.' };
    if (error && typeof error.code === 'string') throw error;
    throw { code: 'INTERNAL', message: error?.message || 'One page could not be prepared.' };
  } finally {
    state.controllers.delete(jobId);
  }
}

async function assembleMain(state, { pages = [], options = {}, jobId = 'pdf-assemble' } = {}) {
  const controller = new AbortController();
  state.controllers.set(jobId, controller);
  try { return await createPdf(pages, options, controller.signal); }
  finally { state.controllers.delete(jobId); }
}


/* ---------- the engines the main thread can serve ---------- */

function capabilitiesFor(name) {
  switch (name) {
    case 'compress':
      return () => ({ supported: mainSupported(), missing: detectMainMissing(), mode: 'main-thread' });
    case 'resize':
      return () => ({
        supported: mainSupported(),
        missing: detectMainMissing(),
        mode: 'main-thread',
        resampler: RESAMPLER_MAIN,
      });
    case 'convert':
      return convertCapabilitiesMain;
    case 'enhance':
      return () => ({
        supported: mainSupported(),
        missing: detectMainMissing(),
        mode: 'main-thread',
        filterPath: detectFilterPathMain(),
        previewWidth: PREVIEW_WIDTH,
        previewMime: PREVIEW_MIME,
      });
    case 'pdf':
      return () => ({ supported: mainSupported(), missing: detectMainMissing(), mode: 'main-thread' });
    default:
      return () => ({ supported: false, missing: ['unknown-engine'], mode: 'main-thread' });
  }
}

export const MAIN = {
  compress: { capabilities: capabilitiesFor('compress'), compress: compressMain },
  resize: { capabilities: capabilitiesFor('resize'), resize: resizeMain },
  convert: { capabilities: capabilitiesFor('convert'), convert: convertMain },
  enhance: {
    capabilities: capabilitiesFor('enhance'),
    previews: previewsMain,
    enhance: enhanceMain,
    selfTest: selfTestMain,
  },
  pdf: { capabilities: capabilitiesFor('pdf'), encodePage: encodePageMain, assemble: assembleMain },
};

export function cancelMain(state, jobId) {
  // The controller is registered when the job starts, so an abort set here reaches whichever band
  // or encode is in flight — the same object the worker's own `cancel()` aborts.
  state.controllers.get(jobId)?.abort();
}
