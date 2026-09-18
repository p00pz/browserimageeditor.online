/**
 * The one ONNX Runtime setup in this project, shared by both model features.
 *
 * Background removal and object erasing are two different models with two different pipelines, but
 * exactly one runtime, one configuration and one way of failing. A second copy of this file would be
 * the point where the two start disagreeing about what "supported" means.
 *
 * **Loaded lazily, and inside the worker only.** `onnxruntime-web` is ~370 KB of JavaScript that no
 * page should download to render text, so it is a dynamic import: Vite emits it as its own chunk,
 * the service worker decides separately whether to warm it, and the main thread never sees it.
 *
 * **Single-threaded on purpose.** `numThreads: 1` avoids SharedArrayBuffer entirely, which is what
 * keeps this site free of the COOP/COEP cross-origin-isolation headers that multi-threaded WASM
 * requires — headers that would later block ad iframes lacking CORP headers, on a site whose
 * business model is those ad slots. The cost is real and stated in the UI: inference takes seconds.
 *
 * **The runtime comes from our own origin.** Left to itself, onnxruntime-web fetches its own wasm
 * from a public CDN. On a site whose entire promise is "your file never leaves your device", a
 * third-party request on every tool visit is not acceptable, so `wasmPaths` points at `/ort/`, which
 * `scripts/gen-ort.mjs` fills from the pinned dependency.
 */
import { CompressError } from './errors.js';

/** Where scripts/gen-ort.mjs puts the runtime, relative to the site root. */
export const WASM_PATH = '/ort/';

/** The runtime is loaded at most once per worker lifetime. */
let runtimePromise = null;

/**
 * Loads and configures ONNX Runtime.
 *
 * Every option is set before the first session is created, because ORT reads them at session
 * construction and silently ignores later changes.
 */
export function loadRuntime() {
  runtimePromise ??= (async () => {
    let ort;
    try {
      ort = await import('onnxruntime-web');
    } catch {
      throw new CompressError(
        'ORT_LOAD_FAILED',
        'The on-device model runtime could not be loaded. Your images were never uploaded; reloading the page usually fixes this.',
      );
    }
    ort.env.wasm.wasmPaths = WASM_PATH;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    // Warnings from the runtime are of no use to a visitor and would fill their console on a page
    // that promises to be quiet. Errors still surface through the thrown exceptions below.
    ort.env.logLevel = 'error';
    return ort;
  })();
  return runtimePromise;
}

/**
 * What this browser can and cannot do, answered without loading anything.
 *
 * Deliberately cheap: it is called by the worker's `capabilities()` the moment a page asks, so it
 * must not touch the network or start a 14 MB download. The things that can only be discovered by
 * trying (does the wasm actually instantiate, does the model load) are reported by the steps that
 * try them.
 */
export function capabilityReport() {
  const missing = [];
  if (typeof WebAssembly !== 'object' && typeof WebAssembly !== 'function') missing.push('WebAssembly');
  else if (typeof WebAssembly?.instantiate !== 'function') missing.push('WebAssembly.instantiate');
  if (typeof OffscreenCanvas !== 'function') missing.push('OffscreenCanvas');
  if (typeof createImageBitmap !== 'function') missing.push('createImageBitmap');

  // Chrome-only, and absent on Safari and Firefox. Used as a hint, never as a gate: a device that
  // does not report memory is not a device without memory.
  const deviceMemoryGB = typeof navigator !== 'undefined' && Number.isFinite(navigator.deviceMemory)
    ? navigator.deviceMemory
    : null;

  return {
    supported: missing.length === 0,
    missing,
    deviceMemoryGB,
    // The runtime is served from our own origin, so this is a same-origin request that the service
    // worker can cache; the models are not, and are handled by core/model-store.js.
    wasmPath: WASM_PATH,
  };
}

/** Sessions are cached by id: a second pass on the same photo must not re-parse 198 MB. */
const sessions = new Map();

/**
 * Creates (or returns) an inference session for a model already in memory.
 *
 * `bytes` comes from core/model-store.js. Size and licence are recorded in content/tools.json and
 * LICENSES-THIRD-PARTY.md; this function trusts the bytes and reports what the model says about
 * itself, so a mismatch between the config and the file surfaces as a clear error rather than as
 * garbage output.
 */
export async function sessionFor(id, bytes) {
  if (sessions.has(id)) return sessions.get(id);

  const ort = await loadRuntime();
  let session;
  try {
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  } catch (error) {
    throw mapRuntimeError(error, 'The model could not be prepared to run on this device.');
  }

  sessions.set(id, session);
  return session;
}

export function hasSession(id) {
  return sessions.has(id);
}

/** Frees every loaded model. Called when a page is torn down, and available to both engines. */
export function releaseSessions() {
  const released = [];
  for (const [id, session] of sessions) {
    try {
      session.release?.();
    } catch {
      // A session that refuses to release is a leak, not a failure worth surfacing.
    }
    released.push(id);
  }
  sessions.clear();
  return released;
}

/**
 * Turns a runtime failure into something a person can act on.
 *
 * The out-of-memory case is the one that matters: a wasm heap that cannot grow throws a message
 * mentioning memory, and the useful advice is about the *image*, not the model — which is why the
 * text points at the photo the visitor chose.
 */
export function mapRuntimeError(error, fallbackMessage) {
  const message = String(error?.message ?? error ?? '');
  if (/out of memory|OOM|Cannot allocate|allocation failed|RangeError/i.test(message)) {
    return new CompressError(
      'OUT_OF_MEMORY',
      'This device ran out of memory running the model. Try a smaller image, or close other tabs and try again.',
    );
  }
  if (/not supported|Unsupported|unknown operator|kernel/i.test(message)) {
    return new CompressError(
      'MODEL_UNSUPPORTED',
      'The model uses an operation this browser’s runtime cannot run. Nothing was uploaded; please report it and try the other mode.',
    );
  }
  return new CompressError('MODEL_RUNTIME_FAILED', fallbackMessage);
}

/**
 * Reads a model's own declared input and output names.
 *
 * Used to fail fast and loudly rather than to guess: the two models' contracts are documented in
 * content/tools.json, and if a published file ever changes shape, the visitor gets "this model does
 * not match the contract this tool expects" instead of a black rectangle.
 */
export function requireNames(session, { inputs, outputs = [] }) {
  const have = session.inputNames ?? [];
  const missing = inputs.filter((name) => !have.includes(name));
  if (missing.length > 0) {
    throw new CompressError(
      'MODEL_CONTRACT_MISMATCH',
      `The downloaded model does not match what this tool expects (missing input ${missing.join(', ')}). Nothing was uploaded.`,
    );
  }
  const haveOutputs = session.outputNames ?? [];
  const preferred = outputs.find((name) => haveOutputs.includes(name)) ?? haveOutputs[0] ?? null;
  return { inputNames: inputs, outputName: preferred };
}
