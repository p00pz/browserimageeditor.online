/**
 * worker-or-main.js — the one shared engine endpoint, which picks worker or main thread.
 *
 * Every tool opens its engine through `openEngine(name, workerUrl)` and then talks to the object
 * it gets back exactly as it used to talk to `Comlink.wrap(worker)`: the same method names, the
 * same arguments, the same `{ blob, meta }` results, the same plain serializable `{ code, message }`
 * rejections. Nothing at a call site becomes async, because the wrapper's methods await an internal
 * mode-resolution promise and only then decide where the call goes.
 *
 * ## Why this exists
 *
 * Safari gained `OffscreenCanvas` **inside a worker** in 16.4. iOS 15.4 through 16.3 — inside this
 * site's stated support range — has `createImageBitmap` and a perfectly good DOM canvas and no
 * worker canvas at all, so a worker that reports `supported: false` leaves every tool dead: the
 * dropzone disabled and "this browser cannot…" on the page. The capability probe is the worker's
 * job and it stays the worker's job; what this module adds is the second half of the answer —
 * *the same engines, on the main thread, without freezing the page*.
 *
 * ## How the mode is picked
 *
 *   1. The worker is created and probed once with `capabilities()`. When it answers `supported`,
 *      every call is forwarded to the Comlink-wrapped worker exactly as before — the fast path is
 *      unchanged, and the tool's own "runs in a Web Worker" copy stays true.
 *   2. When the worker answers unsupported — or throws, or fails to load — the worker is
 *      **terminated** and the same RPC surface is served from the main-thread implementations
 *      below. `capabilities()` then answers `{ supported: true, mode: 'main-thread' }`, which is
 *      what re-enables the dropzone.
 *   3. Only when the main thread itself lacks `createImageBitmap` or `canvas.toBlob` does the
 *      engine stay honestly unsupported, and the tool keeps its existing `[data-unsupported]`
 *      notice for exactly that case.
 *
 * ## What the main-thread path does
 *
 * It reuses the pure engines in `core/engine-*.js` for every decision — sizing, pixel budgets,
 * target-size search, histogram correction, grading, page placement — and supplies only the two
 * browser APIs the workers had: decoding with `createImageBitmap(file, { imageOrientation:
 * 'from-image' })` and canvas work with `document.createElement('canvas')` + `toBlob` instead of
 * `OffscreenCanvas` + `convertToBlob`.
 *
 * It never freezes. Between phases it yields to the main thread, and the pixel-heavy passes run in
 * horizontal row bands, yielding whenever a frame's worth of time has been spent and honouring the
 * job's AbortController between bands, so `queue.cancel()` still reaches an in-flight job.
 *
 * The heavy per-engine dependencies are imported dynamically, as the workers do: a visitor whose
 * browser has a worker never fetches `browser-image-compression` or `pdf-lib` into the main bundle,
 * and a visitor on the main-thread path only fetches the one their tool needs, and only when it
 * runs.
 */
import * as Comlink from 'comlink';

/** The RPC surface each engine exposes, mirrored one-to-one from the worker's `Comlink.expose`. */
const SURFACE = {
  compress: ['capabilities', 'compress', 'cancel'],
  resize: ['capabilities', 'resize', 'cancel'],
  convert: ['capabilities', 'convert', 'cancel'],
  enhance: ['capabilities', 'previews', 'enhance', 'selfTest', 'cancel'],
  pdf: ['capabilities', 'encodePage', 'assemble', 'cancel'],
};

/**
 * How long the capability probe is willing to wait for a worker that has not answered and has not
 * reported an error. Generous, because a worker that is merely cold-starting on a slow phone still
 * answers in well under this — and the price of being wrong is a page that sits disabled.
 */
const PROBE_TIMEOUT_MS = 8000;

/**
 * The lazy bridge to main-engines.js. Imported on demand, so a browser whose worker works — the
 * common case — never fetches the engines' third-party dependencies at all.
 */
let mainModule = null;
async function loadMain() {
  if (!mainModule) mainModule = await import('./main-engines.js');
  return mainModule;
}

/* ---------- the endpoint the tools talk to ---------- */

/**
 * Opens one engine.
 *
 * @param {string} name `compress` | `resize` | `convert` | `enhance` | `pdf`
 * @param {Worker} worker The module worker the tool constructed with
 *        `new Worker(new URL('../workers/x.worker.js', import.meta.url), { type: 'module' })`. It
 *        is constructed in the tool rather than here because that exact shape is what the bundler
 *        recognises; moving the `new URL` behind a variable would leave the worker's own imports
 *        unresolved in the built output. This module owns the worker from here on: it wraps it,
 *        probes it, and terminates it when the main thread takes over or the page goes away.
 * @param {{ onError?: () => void }} [hooks] `onError` is called if a worker that the engine
 *        committed to reports an uncaught error — the `worker.addEventListener('error')` the tools
 *        used to wire themselves. A worker that fails during the probe is not reported, because
 *        that failure is the ordinary reason the main thread takes over and reporting it as a
 *        crash would be wrong.
 * @returns {object} An object with the engine's RPC method names. Every method returns a Promise
 *          and accepts the same arguments the Comlink proxy did, including a progress callback as a
 *          separate top-level argument — which is wrapped in `Comlink.proxy()` here when the call
 *          is forwarded to a worker, so the tools no longer need to know which side they are on.
 */
export function openEngine(name, worker, { onError = null } = {}) {
  const state = { controllers: new Map() };
  let remote = null;
  let modePromise = null;
  // Register the error listener before the first capabilities() call. A module worker can emit its
  // load error in the same turn that the caller opens the engine; registering inside resolveMode()
  // leaves a small race where the probe waits for the full timeout instead of handing over.
  let probeReject = null;
  let probeError = null;
  let committedToWorker = false;
  const handleWorkerError = () => {
    const error = new Error('worker-error');
    if (!committedToWorker) {
      probeError = error;
      probeReject?.(error);
    } else {
      onError?.();
    }
  };
  worker?.addEventListener('error', handleWorkerError);
  /** One proxied callback per function, for the life of the page, so jobs do not leak proxies. */
  const proxyFor = new WeakMap();

  function ensureMode() {
    if (modePromise) return modePromise;
    modePromise = resolveMode().catch((cause) => {
      // A worker that cannot even be probed is the same answer as an unsupported one: the main
      // thread takes over, and if it cannot either, the report says so honestly.
      remote = null;
      return { mode: 'main-thread', report: null, cause };
    });
    return modePromise;
  }

  async function resolveMode() {
    if (worker) {
      try {
        const wrapped = Comlink.wrap(worker);
        // A worker whose module never evaluates — a dependency it could not resolve, a thrown
        // top-level — never registers its listener, so the probe would hang rather than reject.
        // Its own error event is the signal that it will not answer, and a timeout covers a worker
        // that goes quiet without one. Whichever fires first decides.
        let timer = null;
        const failed = new Promise((resolve, reject) => {
          probeReject = reject;
          if (probeError) reject(probeError);
          timer = setTimeout(() => reject(new Error('worker-timeout')), PROBE_TIMEOUT_MS);
        });
        let report;
        try {
          report = await Promise.race([wrapped.capabilities(), failed]);
        } finally {
          clearTimeout(timer);
          probeReject = null;
        }
        if (report && report.supported) {
          remote = wrapped;
          committedToWorker = true;
          return { mode: 'worker', report };
        }
        // The worker is up and honest about what it lacks, which is the case this module exists for.
        worker.terminate();
      } catch {
        try {
          worker?.terminate();
        } catch {
          /* already gone */
        }
      }
    }
    remote = null;

    const { MAIN } = await loadMain();
    const report = await MAIN[name].capabilities(state);
    return { mode: report.supported ? 'main-thread' : 'unsupported', report };
  }

  /** Comlink only wires top-level arguments, so a callback has to arrive as a proxy; a plain
   *  function would be cloned, and a function cannot be cloned. Cached so a page reuses one. */
  function wireArg(arg, mode) {
    if (mode !== 'worker' || typeof arg !== 'function') return arg;
    if (arg[Comlink.proxyMarker]) return arg;
    if (!proxyFor.has(arg)) proxyFor.set(arg, Comlink.proxy(arg));
    return proxyFor.get(arg);
  }

  async function runMethod(method, args) {
    const { mode } = await ensureMode();
    if (mode === 'worker') {
      return remote[method](...args.map((arg) => wireArg(arg, mode)));
    }
    const { MAIN } = await loadMain();
    const impl = MAIN[name][method];
    if (typeof impl !== 'function') {
      throw { code: 'INTERNAL', message: `The ${name} engine has no main-thread implementation of ${method}.` };
    }
    return impl(state, ...args);
  }

  const wrapper = {
    /** Releases the worker (if one is in use) and aborts anything still in flight. */
    dispose() {
      try {
        worker?.terminate();
        worker?.removeEventListener('error', handleWorkerError);
      } catch {
        /* terminated already */
      }
      remote = null;
      modePromise = null;
      for (const controller of state.controllers.values()) controller.abort();
      state.controllers.clear();
    },
  };

  for (const method of SURFACE[name] ?? []) {
    if (method === 'cancel') {
      // Fire-and-forget by nature: the tools call it from an abort listener and never await it.
      // It returns a promise anyway, because the Comlink proxy it replaces does — `loadPreviews`
      // chains a `.catch()` onto its cancel, and one that returned `undefined` would throw there and
      // take the whole preview load down with it. It has to work before the mode resolves too, so it
      // resolves the mode itself.
      wrapper.cancel = (jobId) =>
        ensureMode()
          .then(({ mode }) => {
            if (mode === 'worker') return remote.cancel(jobId).catch(() => {});
            return loadMain().then((m) => m.cancelMain(state, jobId));
          })
          .catch(() => loadMain().then((m) => m.cancelMain(state, jobId)));
      continue;
    }
    if (method === 'capabilities') {
      // The report carries the mode it came from, so a page can say which engine is running.
      wrapper.capabilities = (...args) =>
        ensureMode().then(({ mode, report, cause }) => {
          if (mode === 'worker') return { ...report, mode: 'worker' };
          return report ?? { supported: false, missing: ['engine'], mode: 'main-thread', cause: String(cause?.message ?? cause ?? 'unknown') };
        });
      continue;
    }
    wrapper[method] = (...args) => runMethod(method, args);
  }

  return wrapper;
}
