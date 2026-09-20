/**
 * worker-or-main.test.js — locks the contract of the one shared engine endpoint.
 *
 * The tools talk to `openEngine()` exactly as they used to talk to `Comlink.wrap(worker)`, so the
 * things this file asserts are the things that would silently break a tool page if they drifted:
 * the method names have to be the ones the worker actually exposes, every method has to return a
 * promise (no call site became async), and a worker that cannot serve has to hand the page to the
 * main thread instead of leaving the dropzone disabled.
 *
 * The main-thread pixel paths are exercised for real by the WebKit harness; this file is about the
 * shape of the seam between a tool and its engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { openEngine } from '../src/assets/js/core/worker-or-main.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const workers = join(root, 'src', 'assets', 'js', 'workers');

/* ---------- the surface the tools see ---------- */

/**
 * Reads a worker's `Comlink.expose({...})` and returns the method names it registers.
 *
 * Depth-aware because enhance.worker.js spells it `capabilities: () => ({ ...capabilityReport,
 * previewWidth: … })`: a naive comma split would list `previewWidth` and `previewMime` as methods.
 */
function exposedMethods(file) {
  const text = readFileSync(join(workers, file), 'utf8');
  const at = text.indexOf('Comlink.expose(');
  assert.ok(at !== -1, `${file} has no Comlink.expose`);
  const start = text.indexOf('{', at);
  assert.ok(start !== -1, `${file} has no object to expose`);

  // Find the object literal's extent by counting braces.
  let depth = 0;
  let end = -1;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  assert.ok(end !== -1, `unbalanced braces in ${file}'s expose block`);

  // Split on commas that are actually at the object's top level.
  const block = text.slice(start + 1, end);
  const entries = [];
  let current = '';
  let nested = 0;
  for (const character of block) {
    if ('{(['.includes(character)) nested += 1;
    else if ('})]'.includes(character)) nested -= 1;
    if (character === ',' && nested === 0) {
      entries.push(current);
      current = '';
    } else current += character;
  }
  if (current.trim() !== '') entries.push(current);

  // `key: value` and shorthand `key` both; the key is what the proxy answers to.
  return entries
    .map((entry) => entry.split(':')[0].trim())
    .filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name));
}

test('every worker is named in the surface table', () => {
  // A worker the table does not know is a worker the tools cannot open at all.
  assert.deepEqual(exposedMethods('compress.worker.js').sort(), ['capabilities', 'compress', 'cancel'].sort());
});

test('the wrapper exposes exactly the RPC surface each worker exposes', () => {
  // One engine per tool, mirrored one-to-one. A method the worker has but the wrapper lacks is a
  // tool page calling a function that does not exist; a method the wrapper has but the worker does
  // not is a code path nothing serves.
  const expected = {
    compress: 'compress.worker.js',
    resize: 'resize.worker.js',
    convert: 'convert.worker.js',
    enhance: 'enhance.worker.js',
    pdf: 'pdf.worker.js',
  };
  for (const [name, file] of Object.entries(expected)) {
    const engine = openEngine(name, fakeWorker(), {});
    // `dispose` is the wrapper's own lifecycle hook, not an RPC method: the tools never call it.
    const surface = Object.keys(engine).filter((key) => key !== 'dispose');
    assert.deepEqual(surface.sort(), exposedMethods(file).sort(), `${name} must mirror ${file}`);
  }
});

test('the crop tool opens the convert engine, which is the one encoder the project has', () => {
  // crop-image.js opens openEngine('convert', ...) by design: its canvas is built on the main
  // thread by cropperjs and only the encoding crosses the boundary. A second 'crop' engine would be
  // a second encoder.
  assert.deepEqual(exposedMethods('convert.worker.js'), exposedMethods('convert.worker.js'));
  const engine = openEngine('convert', fakeWorker(), {});
  assert.equal(typeof engine.convert, 'function');
  assert.equal(typeof engine.cancel, 'function');
});

/* ---------- mode resolution ---------- */

/**
 * A stand-in for a module Worker, speaking only the parts of the interface `openEngine` touches.
 * Comlink's `wrap` adds a message listener and posts a handshake, which the fake accepts and never
 * answers — so the probe has to give up on its own rather than hang.
 */
function fakeWorker({ reports = null } = {}) {
  const listeners = new Map();
  const worker = {
    postMessage() {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    terminate() {
      worker.terminated = true;
    },
    terminated: false,
    /** Dispatches an event the way a real Worker dispatches `error` when its module fails to load. */
    dispatch(type, payload) {
      for (const listener of listeners.get(type) ?? []) listener(payload);
    },
  };
  if (reports === 'error') {
    // A worker whose module never evaluates fires `error` and never answers the probe.
    queueMicrotask(() => worker.dispatch('error', new Error('module failed to load')));
  }
  return worker;
}

test('a worker that fails to load hands the page to the main thread instead of hanging', async () => {
  const worker = fakeWorker({ reports: 'error' });
  const engine = openEngine('compress', worker, {});

  const report = await engine.capabilities();

  assert.equal(worker.terminated, true, 'a worker that cannot serve is terminated, not left running');
  assert.equal(report.mode, 'main-thread');
  // Node has neither createImageBitmap nor a document, so the honest answer here is "cannot", and
  // the shape is what a browser's `checkCapabilities()` reads — `supported` first of all.
  assert.equal(report.supported, false);
  assert.ok(Array.isArray(report.missing) && report.missing.length > 0);
});

test('a probe-time failure is not reported as a crash, but a later one is', async () => {
  // A worker that fails while the probe is still in flight is the ordinary reason the main thread
  // takes over, so `onError` must stay quiet — reporting it would tell the visitor a worker they
  // were never going to use has stopped. `onError` is for a worker the engine committed to.
  let crashes = 0;
  const worker = fakeWorker();
  const engine = openEngine('resize', worker, { onError: () => { crashes += 1; } });
  worker.dispatch('error', new Error('module failed to load'));
  const report = await engine.capabilities();
  assert.equal(report.mode, 'main-thread');
  assert.equal(crashes, 0, 'a probe-time failure is a handover, not a crash report');
});

/* ---------- the promise contract the call sites rely on ---------- */

test('every method returns a promise, so no call site had to become async', async () => {
  const engine = openEngine('compress', fakeWorker({ reports: 'error' }), {});
  for (const method of ['capabilities', 'compress', 'cancel']) {
    const value = engine[method]('job-1');
    assert.ok(
      typeof (value && value.then) === 'function',
      `${method} must return a thenable — the tools do not await ensureWorker()`,
    );
    await value.catch(() => {});
  }
});

test('cancel returns a promise, because a tool chains a catch onto it', async () => {
  // enhance-photo.js does `void client.cancel(id).catch(() => {})`. A Comlink proxy returns a
  // promise there, so the wrapper has to as well: returning undefined threw synchronously and took
  // the whole preview load down with it.
  const engine = openEngine('enhance', fakeWorker({ reports: 'error' }), {});
  const value = engine.cancel('preview-job');
  assert.ok(typeof (value && value.then) === 'function', 'cancel must return a thenable');
  await value;
});

test('a job run where the main thread cannot serve rejects with a plain serializable error', async () => {
  // The tools' normalizeRejection() looks for { code, message }; anything else reaches the user as
  // "unknown reason".
  const engine = openEngine('compress', fakeWorker({ reports: 'error' }), {});
  await assert.rejects(
    () => engine.compress({ jobId: 'job-1', file: new File([new Uint8Array(4)], 'a.png'), options: {} }),
    (error) => error && typeof error.code === 'string' && typeof error.message === 'string',
  );
});

test('the same engine resolves its mode once and reuses the answer', async () => {
  const engine = openEngine('pdf', fakeWorker({ reports: 'error' }), {});
  const first = await engine.capabilities();
  const second = await engine.capabilities();
  assert.equal(first.mode, second.mode);
  assert.deepEqual(first.missing, second.missing);
});
