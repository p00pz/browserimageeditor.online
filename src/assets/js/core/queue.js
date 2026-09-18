/**
 * Batch queue — no browser APIs, no dependencies, everything injected.
 *
 * It runs a list of files through a `run(file, { id, signal, report })` function, which is
 * what lets the compress tool drive the worker and lets tests/queue.test.js drive a fake. The
 * same code path handles one file or fifty; nothing special-cases a single file.
 *
 * Concurrency defaults to 2, and that is a memory bound rather than a tuning knob: one
 * 20-megapixel decode is roughly 80 MB of RGBA, so starting fifty of them at once would be
 * a reliable way to make a phone tab crash.
 *
 * Item states: queued -> running -> done | error | cancelled. One failing file never stops
 * the batch, and results keep the order they were added in.
 */
import { CompressError } from './errors.js';

export const DEFAULT_CONCURRENCY = 2;

const FINISHED = new Set(['done', 'error', 'cancelled']);

let sequence = 0;

function nextId() {
  sequence += 1;
  return `job-${sequence}`;
}

function clampRatio(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toItemError(error) {
  if (error instanceof CompressError) return { code: error.code, message: error.message };
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    return { code: error.code, message: error.message ?? 'Something went wrong.' };
  }
  if (error?.name === 'AbortError') return { code: 'ABORTED', message: 'Compression was cancelled.' };
  return { code: 'INTERNAL', message: error?.message ?? 'Something went wrong.' };
}

export function createQueue({ run, concurrency = DEFAULT_CONCURRENCY, onUpdate } = {}) {
  if (typeof run !== 'function') {
    throw new Error('createQueue: a run(file, { id, signal, report }) function is required.');
  }

  const limit = Math.max(1, Math.round(concurrency) || DEFAULT_CONCURRENCY);
  const items = [];
  const byId = new Map();
  const controllers = new Map();
  const idleWaiters = [];
  let running = 0;
  let disposed = false;

  function snapshot() {
    const finished = items.filter((item) => FINISHED.has(item.status));
    const total = items.length;
    const progressSum = items.reduce((sum, item) => sum + (FINISHED.has(item.status) ? 1 : item.ratio), 0);
    return {
      items: items.map((item) => ({ ...item })),
      total,
      finished: finished.length,
      succeeded: items.filter((item) => item.status === 'done').length,
      failed: items.filter((item) => item.status === 'error').length,
      cancelled: items.filter((item) => item.status === 'cancelled').length,
      queued: items.filter((item) => item.status === 'queued').length,
      running,
      ratio: total === 0 ? 0 : progressSum / total,
      idle: running === 0 && !items.some((item) => item.status === 'queued'),
    };
  }

  function emit() {
    onUpdate?.(snapshot());
  }

  function releaseIdle() {
    if (running > 0 || items.some((item) => item.status === 'queued')) return;
    while (idleWaiters.length > 0) idleWaiters.shift()(snapshot());
  }

  function whenIdle() {
    if (running === 0 && !items.some((item) => item.status === 'queued')) return Promise.resolve(snapshot());
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  async function startItem(item) {
    item.status = 'running';
    item.attempts += 1;
    item.ratio = 0;
    running += 1;

    const controller = new AbortController();
    controllers.set(item.id, controller);
    emit();

    try {
      item.result = (await run(item.file, {
        id: item.id,
        signal: controller.signal,
        report: (ratio) => {
          item.ratio = clampRatio(ratio);
          emit();
        },
      })) ?? null;
      item.ratio = 1;
      item.status = 'done';
      item.error = null;
    } catch (error) {
      item.ratio = 1;
      item.error = toItemError(error);
      item.status = item.error.code === 'ABORTED' ? 'cancelled' : 'error';
    } finally {
      controllers.delete(item.id);
      running -= 1;
      emit();
      pump();
      releaseIdle();
    }
  }

  function pump() {
    if (disposed) return;
    while (running < limit) {
      const next = items.find((item) => item.status === 'queued');
      if (!next) return;
      void startItem(next);
    }
  }

  function add(files) {
    const added = [];
    for (const file of files ?? []) {
      if (!file) continue;
      const item = {
        id: nextId(),
        file,
        status: 'queued',
        ratio: 0,
        attempts: 0,
        result: null,
        error: null,
      };
      items.push(item);
      byId.set(item.id, item);
      added.push({ ...item });
    }
    emit();
    return added;
  }

  function cancelOne(item) {
    if (item.status === 'queued') {
      item.status = 'cancelled';
      item.ratio = 1;
      item.error = { code: 'ABORTED', message: 'Cancelled before it started.' };
      return;
    }
    controllers.get(item.id)?.abort();
  }

  return {
    /** Queues files and starts working through them. Resolves when the queue goes idle. */
    async process(files) {
      add(files);
      pump();
      return whenIdle();
    },
    add,
    start() {
      pump();
      return whenIdle();
    },
    /** Cancels one item by id, or everything currently queued/running when called bare. */
    cancel(id = null) {
      if (id === null) {
        for (const item of items) {
          if (!FINISHED.has(item.status)) cancelOne(item);
        }
      } else {
        const item = byId.get(id);
        if (item && !FINISHED.has(item.status)) cancelOne(item);
      }
      emit();
      releaseIdle();
    },
    /** Re-queues a finished-but-failed or cancelled item. */
    async retry(id) {
      const item = byId.get(id);
      if (!item || !FINISHED.has(item.status)) return whenIdle();
      item.status = 'queued';
      item.ratio = 0;
      item.error = null;
      item.result = null;
      emit();
      pump();
      return whenIdle();
    },
    snapshot,
    whenIdle,
    /** Aborts everything in flight and refuses further work. */
    dispose() {
      disposed = true;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      for (const item of items) {
        if (item.status === 'queued') item.status = 'cancelled';
      }
      releaseIdle();
    },
  };
}
