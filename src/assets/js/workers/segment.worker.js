/**
 * Model worker — background removal and object erasing, both off the main thread.
 *
 * Contract (same shape as compress.worker.js and convert.worker.js):
 *   capabilities()                                  -> { supported, missing[], deviceMemoryGB }
 *   prepare({ id, url, expectedBytes }, onProgress) -> { id, source, persisted, bytes, outputName }
 *   removeBackground({ jobId, file, options }, onProgress) -> { blob, meta }
 *   eraseObject({ jobId, file, mask, options }, onProgress) -> { blob, meta }
 *   cancel(jobId)                                   -> void
 *
 * `onProgress` is a separate top-level argument, never nested in the payload: comlink serialises
 * top-level arguments with `Comlink.proxy()` and nothing deeper, which is the bug that made every
 * tool in this project silently fall back to "this browser cannot do this" once. See
 * compress.worker.js for the full account.
 *
 * **One ONNX path for both features.** Model bytes come from core/model-store.js, the runtime comes
 * from core/onnx.js, sessions are cached in one map, and the two engines are called with a runtime
 * they did not load themselves. A second loading path would be the place where "supported" starts
 * meaning two different things on the same page.
 *
 * **Model bytes are fetched here, not on the page.** A 198 MB download has to stream, report
 * progress and be cancelable, and none of that belongs on the main thread.
 */
import * as Comlink from 'comlink';

import { CompressError } from '../core/errors.js';
import { capabilityReport, hasSession, loadRuntime, releaseSessions, requireNames, sessionFor } from '../core/onnx.js';
import { hasStoredModel, loadModelBytes } from '../core/model-store.js';
import { SEGMENT_CONTRACT, removeBackground as runRemoveBackground } from '../core/engine-segment.js';
import { INPAINT_CONTRACT, eraseObject as runEraseObject } from '../core/engine-inpaint.js';

/**
 * What each model id means: the inputs it must have, the output we prefer, and the engine's own
 * declared contract. Keeping the names here means a publisher changing a graph's interface fails as
 * a clear message ("missing input mask") instead of as a black rectangle.
 */
const MODELS = {
  segment: {
    inputs: [SEGMENT_CONTRACT.inputName],
    outputs: SEGMENT_CONTRACT.acceptableOutputs,
  },
  inpaint: {
    inputs: [INPAINT_CONTRACT.imageInput, INPAINT_CONTRACT.maskInput],
    outputs: [INPAINT_CONTRACT.output],
  },
};

/** The output name each prepared session should fetch, discovered from the session itself. */
const outputNames = new Map();
const controllers = new Map();

function capabilities() {
  return capabilityReport();
}

/** True when the model is already stored, so the page can label the download button honestly. */
async function stored(id, url) {
  if (outputNames.has(id)) return true;
  return hasStoredModel(url);
}

/**
 * Fetches (or reuses) a model and prepares a session for it.
 *
 * Progress phases the UI cares about: 'model' while downloading (with received/total), then
 * 'prepare' while the runtime parses 198 MB of graph.
 */
async function prepare({ id, url, expectedBytes = null } = {}, onProgress) {
  const model = MODELS[id];
  if (!model) throw { code: 'UNKNOWN_MODEL', message: `No model is configured under the id "${id}".` };
  if (!url) throw { code: 'MODEL_URL_MISSING', message: 'No model URL was configured for this tool.' };

  try {
    if (outputNames.has(id)) {
      return { id, ready: true, source: 'memory', persisted: true };
    }

    onProgress?.({ phase: 'model', ratio: null, received: 0, total: expectedBytes });
    const loaded = await loadModelBytes({
      url,
      expectedBytes,
      onProgress: (event) =>
        onProgress?.({
          phase: 'model',
          received: event.received,
          total: event.total,
          ratio: event.ratio,
          source: event.phase,
        }),
    });

    onProgress?.({ phase: 'prepare', ratio: 0.9 });
    const session = await sessionFor(id, loaded.bytes);
    const { outputName } = requireNames(session, { inputs: model.inputs, outputs: model.outputs });
    outputNames.set(id, outputName);

    return {
      id,
      ready: true,
      source: loaded.source,
      persisted: loaded.persisted !== false,
      bytes: loaded.bytes.byteLength,
      outputName,
    };
  } catch (error) {
    throw toWorkerError(error, 'The model could not be prepared on this device.');
  }
}

async function removeBackground(payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  return withJob(jobId, async (signal) => {
    requireFile(file);
    // A session only exists after `prepare` has fetched the model and built it, so this is the
    // check that turns "the model has not been downloaded yet" into a sentence rather than into an
    // inference attempt against nothing.
    if (!hasSession('segment')) throw missing('segment');
    const session = await sessionFor('segment');

    const ort = await loadRuntime();
    const { blob, meta } = await runRemoveBackground({
      bitmap: await decode(file),
      session,
      ort,
      outputName: outputNames.get('segment') ?? null,
      options,
      signal,
      onProgress: jobProgress(jobId, onProgress),
    });
    return { blob, meta: { ...meta, sourceBytes: file.size, outputBytes: blob.size } };
  });
}

async function eraseObject(payload = {}, onProgress) {
  const { jobId, file, mask, options = {} } = payload;
  return withJob(jobId, async (signal) => {
    requireFile(file);
    if (!mask || !mask.length) throw { code: 'EMPTY_MASK', message: 'Paint over the object you want removed first.' };
    if (!hasSession('inpaint')) throw missing('inpaint');
    const session = await sessionFor('inpaint');

    const ort = await loadRuntime();
    const { blob, meta } = await runEraseObject({
      bitmap: await decode(file),
      mask: mask instanceof Uint8ClampedArray ? mask : new Uint8ClampedArray(mask),
      session,
      ort,
      outputName: outputNames.get('inpaint') ?? null,
      options,
      signal,
      onProgress: jobProgress(jobId, onProgress),
    });
    return { blob, meta: { ...meta, sourceBytes: file.size, outputBytes: blob.size } };
  });
}

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw { code: 'DECODE_FAILED', message: 'That file could not be decoded as an image.' };
  }
}

function requireFile(file) {
  if (!file || file.size === 0) throw { code: 'INVALID_INPUT', message: 'No image file was provided.' };
}

function missing(id) {
  return {
    code: 'MODEL_NOT_READY',
    message:
      id === 'inpaint'
        ? 'The object removal model has not been downloaded yet. Start the download above and it will run here afterwards.'
        : 'The background removal model has not been downloaded yet. It downloads once, then runs on your device.',
  };
}

/** Runs a job with its own AbortController, so Cancel stops inference rather than only its display. */
async function withJob(jobId, run) {
  if (!jobId) throw { code: 'INVALID_JOB', message: 'A job needs an id.' };
  const controller = new AbortController();
  controllers.set(jobId, controller);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw { code: 'ABORTED', message: 'That was cancelled.' };
    throw toWorkerError(error, 'That did not work on this device.');
  } finally {
    controllers.delete(jobId);
  }
}

function jobProgress(jobId, onProgress) {
  return (event) => onProgress?.({ jobId, ...event });
}

function cancel(jobId) {
  controllers.get(jobId)?.abort();
}

/** Frees the loaded models. Exposed so a page can hand memory back when it is done. */
function release() {
  return releaseSessions();
}

function toWorkerError(error, fallbackMessage) {
  if (error instanceof CompressError) return { code: error.code, message: error.message };
  if (error && typeof error.code === 'string' && typeof error.message === 'string') return error;
  return { code: 'INTERNAL', message: error?.message || fallbackMessage };
}

Comlink.expose({ capabilities, stored, prepare, removeBackground, eraseObject, cancel, release });
