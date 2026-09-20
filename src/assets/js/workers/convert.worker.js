/**
 * Convert worker — decode, redraw, re-encode, all off the main thread.
 *
 * Contract (same shape as compress.worker.js):
 *   capabilities()                                   -> { supported, missing[], encodable[], heic }
 *   convert({ jobId, file, options }, onProgress)     -> { blob, meta }
 *   cancel(jobId)                                     -> void
 *
 * `onProgress` is a separate top-level argument: comlink wires top-level arguments only, so a
 * callback nested in the payload object would be cloned (and a function cannot be) rather than
 * proxied. See compress.worker.js for the full note.
 *
 * This worker is also what the crop tool uses to encode its result: crop produces a canvas on the
 * main thread (an interactive editor cannot move off it) and hands the resulting Blob here, so
 * there is one encoder implementation in the project rather than two.
 *
 * **Encoder support is measured, not assumed.** `convertToBlob({ type: 'image/avif' })` in Chrome
 * resolves successfully and hands back a PNG, so every candidate format is probed by encoding a
 * 1x1 canvas and reading `blob.type` back. Whatever the probe rejects is never offered, and the
 * engine refuses a requested format the browser cannot write rather than substituting one.
 *
 * **HEIC is decoded on demand.** Safari reads HEIC with createImageBitmap directly, so those
 * visitors never fetch anything extra. Everywhere else the native decode throws, and only then is
 * `heic-to` imported — a dynamic import, so Vite emits it as a separate file that is fetched from
 * this site when a HEIC actually arrives and never before. `heic-to` is LGPL-3.0 (it wraps
 * libheif), pinned to an exact version in package.json, credited in the privacy page, and
 * `heic-to/csp` is the documented escape hatch if a strict CSP blocks the default build.
 */
import * as Comlink from 'comlink';

import { CompressError, assertPixelBudget, safeMaxPixels } from '../core/engine-compress.js';
import { CANVAS_OUTPUT_FORMATS, isHeicFile } from '../core/formats.js';
import { encodeOptions, needsOpaqueBackdrop, planConversion } from '../core/engine-convert.js';

const controllers = new Map();

/**
 * Probed once, on the first call, and deliberately not with a top-level await: this module must
 * reach `Comlink.expose` synchronously when it is evaluated, or a page that asks for capabilities
 * immediately after constructing the worker could talk to a worker that has not started listening
 * yet.
 */
let capabilityPromise = null;

function capabilities() {
  if (!capabilityPromise) capabilityPromise = detectCapabilities();
  return capabilityPromise;
}

/**
 * Encodes a 1x1 canvas and checks what format actually came back.
 *
 * The pixel drawn before the encode is not decoration: `convertToBlob` on a canvas with no
 * rendering context throws `InvalidStateError: "OffscreenCanvas" has no rendering context` in
 * Chrome, which the catch below would report as "this browser cannot write the format" — turning a
 * probe bug into a page-wide refusal to convert anything. Measured in Chrome 130: context-less it
 * throws for every type; with a 2d context each type comes back with its own blob.type.
 */
async function canEncode(mime) {
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d');
    context.fillRect(0, 0, 1, 1);
    const blob = await canvas.convertToBlob({ type: mime });
    return blob?.type === mime;
  } catch {
    return false;
  }
}

async function detectCapabilities() {
  const missing = [];
  if (typeof createImageBitmap !== 'function') missing.push('createImageBitmap');
  if (typeof OffscreenCanvas !== 'function') {
    missing.push('OffscreenCanvas');
    return { supported: false, missing, encodable: [], heic: null };
  }
  const probe = new OffscreenCanvas(1, 1);
  if (typeof probe.getContext !== 'function') missing.push('OffscreenCanvas.getContext');
  if (typeof probe.convertToBlob !== 'function') missing.push('OffscreenCanvas.convertToBlob');
  if (missing.length > 0) return { supported: false, missing, encodable: [], heic: null };

  const encodable = [];
  for (const mime of CANVAS_OUTPUT_FORMATS) {
    if (await canEncode(mime)) encodable.push(mime);
  }

  // `native` stays null rather than false: there is no cheap way to ask a browser whether it can
  // read HEIC without a HEIC to try, so the real answer is discovered by trying. The page's copy
  // says "on your device", which is true either way.
  return { supported: true, missing, encodable, heic: { native: null, decoder: true } };
}

async function decodeHeic(file) {
  const { heicTo } = await import('heic-to');
  return heicTo({ blob: file, type: 'bitmap' });
}

/**
 * Decodes to a bitmap, preferring the browser's own decoder and falling back only for HEIC.
 * Returns which route was used so the result panel can be honest about it.
 */
async function decodeToBitmap(file) {
  try {
    return { bitmap: await createImageBitmap(file, { imageOrientation: 'from-image' }), route: 'native' };
  } catch (error) {
    if (!isHeicFile(file)) {
      throw { code: 'DECODE_FAILED', message: 'That file could not be decoded as an image.' };
    }
    try {
      return { bitmap: await decodeHeic(file), route: 'decoder' };
    } catch {
      throw { code: 'DECODE_FAILED', message: 'That HEIC file could not be decoded, even with the decoder.' };
    }
  }
}

async function convert(payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  const report = await capabilities();
  if (!report.supported) {
    throw {
      code: 'UNSUPPORTED',
      message: `This browser is missing ${report.missing.join(', ')}, so images cannot be converted on your device here.`,
    };
  }
  if (!jobId) throw { code: 'INVALID_JOB', message: 'A conversion job needs an id.' };
  if (!file || file.size === 0) throw { code: 'INVALID_INPUT', message: 'No image file was provided.' };

  const controller = new AbortController();
  controllers.set(jobId, controller);
  const { signal } = controller;

  try {
    onProgress?.({ jobId, phase: 'probe', ratio: 0.1 });

    const plan = planConversion({
      file,
      requested: options.outputMime ?? null,
      supported: report.encodable,
    });

    const { bitmap, route } = await decodeToBitmap(file);
    if (signal.aborted) throw { code: 'ABORTED', message: 'Conversion was cancelled.' };

    // Captured before close(): a closed ImageBitmap is detached and reports 0 for width/height,
    // so reading it afterwards would fill the result readout with "0×0".
    const size = { width: bitmap.width, height: bitmap.height };

    // Checked before the output canvas is allocated, because allocating it *is* the thing that
    // runs the device out of memory on a huge photo. The budget is the platform's own canvas limit.
    assertPixelBudget(size.width, size.height, safeMaxPixels(options.maxPixels, navigator.userAgent));

    onProgress?.({ jobId, phase: 'encode', ratio: 0.6 });

    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    if (plan.needsBackdrop) {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, bitmap.width, bitmap.height);
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    const blob = await canvas.convertToBlob(encodeOptions({ mime: plan.mime, quality: options.quality ?? plan.quality }));
    if (!blob || !Number.isFinite(blob.size)) {
      throw { code: 'ENCODE_FAILED', message: 'The encoder did not return a usable image.' };
    }
    if (blob.type !== plan.mime) {
      // Belt and braces: the probe said this format works, so a mismatch means something changed
      // under us (a browser quirk, or an AVIF-shaped trap). Better a clear failure than a file in
      // a format nobody asked for.
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
    if (signal.aborted) throw { code: 'ABORTED', message: 'Conversion was cancelled.' };
    if (error && typeof error.code === 'string') throw error;
    throw { code: 'INTERNAL', message: error?.message || 'Conversion failed for an unknown reason.' };
  } finally {
    controllers.delete(jobId);
  }
}

function cancel(jobId) {
  controllers.get(jobId)?.abort();
}

Comlink.expose({ capabilities, convert, cancel });
