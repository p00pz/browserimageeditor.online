/**
 * Compression worker — the only file that owns browser capabilities.
 *
 * Transport is comlink. Every decision lives in ../core/engine-compress.js and
 * ../core/target-size.js; this file just supplies the two browser APIs the engine asks for
 * and keeps one AbortController per job so a cancel actually reaches an in-flight encode
 * (browser-image-compression accepts a native AbortSignal, so cancellation is real rather
 * than a flag checked between files).
 *
 * RPC surface:
 *   capabilities()                                 -> { supported, missing[] }
 *   compress({ jobId, file, options }, onProgress)  -> { blob, meta }
 *   cancel(jobId)                                  -> void
 *
 * `onProgress` must be a comlink proxy created on the calling thread and passed as a **separate
 * top-level argument**, never as a property of the payload object. Comlink serialises top-level
 * arguments only — its `toWireValue` does not recurse — so a proxy nested inside an object is sent
 * as a raw value and the postMessage fails with DataCloneError on the function. It receives
 * `{ jobId, phase, ratio, attempt?, quality?, bytes? }`.
 *
 * Failures are thrown as plain serializable `{ code, message }` objects: structured cloning
 * keeps a plain object's fields but drops custom properties off an Error subclass, so
 * `error.code` would not survive the trip otherwise. The calling tool maps codes to its own
 * copy — the codes are UNSUPPORTED, DECODE_FAILED, IMAGE_TOO_LARGE, ABORTED, ENCODE_FAILED,
 * INVALID_* and INTERNAL.
 */
import * as Comlink from 'comlink';
import imageCompression from 'browser-image-compression';

import { CompressError, compressFile } from '../core/engine-compress.js';

const controllers = new Map();
const capabilityReport = detectCapabilities();

function detectCapabilities() {
  const missing = [];
  if (typeof createImageBitmap !== 'function') missing.push('createImageBitmap');
  if (typeof OffscreenCanvas !== 'function') {
    missing.push('OffscreenCanvas');
    return { supported: false, missing };
  }
  const probe = new OffscreenCanvas(1, 1);
  if (typeof probe.getContext !== 'function') missing.push('OffscreenCanvas.getContext');
  if (typeof probe.convertToBlob !== 'function') missing.push('OffscreenCanvas.convertToBlob');
  return { supported: missing.length === 0, missing };
}

/**
 * Source dimensions, and the only decode the engine does outside the encoder.
 *
 * `imageOrientation: 'from-image'` is the same correction every other worker applies: a phone
 * photo stored sideways decodes upright, so the pixel budget and the reported dimensions describe
 * the image the visitor actually sees.
 */
async function probeSize(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close?.();
  }
}

function toPlainError(error, signal) {
  if (error instanceof CompressError) return { code: error.code, message: error.message };
  if (signal?.aborted || error?.name === 'AbortError') {
    return { code: 'ABORTED', message: 'Compression was cancelled.' };
  }
  return { code: 'INTERNAL', message: error?.message || 'Compression failed for an unknown reason.' };
}

async function compress(payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  if (!capabilityReport.supported) {
    throw {
      code: 'UNSUPPORTED',
      message: `This browser is missing ${capabilityReport.missing.join(', ')}, so images cannot be compressed offline here.`,
    };
  }
  if (!jobId) {
    throw { code: 'INVALID_JOB', message: 'A compression job needs an id.' };
  }

  const controller = new AbortController();
  controllers.set(jobId, controller);

  try {
    return await compressFile(
      file,
      {
        ...options,
        signal: controller.signal,
        onProgress: (update) => onProgress?.({ jobId, ...update }),
        // The canvas area a browser can actually allocate is decided by the platform, and the
        // engine's pixel budget has to match it. The worker is where the user agent is visible.
        userAgent: navigator.userAgent,
      },
      { imageCompression, probeSize },
    );
  } catch (error) {
    throw toPlainError(error, controller.signal);
  } finally {
    controllers.delete(jobId);
  }
}

function cancel(jobId) {
  controllers.get(jobId)?.abort();
}

Comlink.expose({ capabilities: () => capabilityReport, compress, cancel });
