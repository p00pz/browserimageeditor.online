/**
 * Batch queue tests. The unit of work is injected, so the whole thing runs in plain Node —
 * which is the only way to check the concurrency bound without a browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createQueue, DEFAULT_CONCURRENCY } from '../src/assets/js/core/queue.js';

function files(count) {
  return Array.from({ length: count }, (_, index) => ({ name: `image-${index + 1}.jpg`, size: 1024 * (index + 1) }));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks and pending timers run, so the pump can start the next item. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('the default concurrency is a small memory bound', () => {
  assert.equal(DEFAULT_CONCURRENCY, 2);
});

test('a missing run function is refused', () => {
  assert.throws(() => createQueue({}), /run\(file/);
});

test('one file and fifty files go through the same path', async () => {
  const single = createQueue({ run: async (file) => ({ name: file.name }) });
  const singleState = await single.process(files(1));
  assert.equal(singleState.total, 1);
  assert.equal(singleState.succeeded, 1);

  const many = createQueue({ run: async (file) => ({ name: file.name }) });
  const manyState = await many.process(files(50));
  assert.equal(manyState.total, 50);
  assert.equal(manyState.succeeded, 50);
  assert.equal(manyState.ratio, 1);
  assert.equal(manyState.idle, true);
});

test('never more files in flight than the concurrency limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const gates = new Map();

  const queue = createQueue({
    concurrency: 2,
    run: async (file, { id }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const gate = deferred();
      gates.set(id, gate);
      try {
        await gate.promise;
        return { name: file.name };
      } finally {
        inFlight -= 1;
      }
    },
  });

  const done = queue.process(files(6));
  let released = 0;
  while (released < 6) {
    for (const [id, gate] of [...gates]) {
      gates.delete(id);
      released += 1;
      gate.resolve();
    }
    await settle();
  }

  const state = await done;
  assert.equal(peak, 2);
  assert.equal(state.succeeded, 6);
  assert.equal(inFlight, 0);
});

test('results keep the order the files were added in', async () => {
  const queue = createQueue({
    concurrency: 2,
    run: async (file) => {
      // Deliberately finish sooner for later files, so completion order differs from input order.
      await new Promise((resolve) => setTimeout(resolve, file.size));
      return { name: file.name };
    },
  });
  const state = await queue.process([
    { name: 'slow.jpg', size: 30 },
    { name: 'medium.jpg', size: 20 },
    { name: 'fast.jpg', size: 1 },
  ]);
  assert.deepEqual(
    state.items.map((item) => item.result.name),
    ['slow.jpg', 'medium.jpg', 'fast.jpg'],
  );
});

test('the queue hands each item its id and reports per-item progress', async () => {
  const seen = [];
  const queue = createQueue({
    run: async (file, { id, report }) => {
      seen.push(id);
      report(0.25);
      report(0.75);
      return { name: file.name };
    },
  });
  const state = await queue.process(files(3));
  assert.equal(seen.length, 3);
  assert.ok(seen.every((id) => typeof id === 'string' && id.length > 0));
  assert.equal(new Set(seen).size, 3);
  assert.ok(state.items.every((item) => item.ratio === 1));
});

test('aggregate progress averages the items', async () => {
  const updates = [];
  const gates = new Map();
  const queue = createQueue({
    concurrency: 2,
    onUpdate: (state) => updates.push(state.ratio),
    run: async (file, { id }) => {
      const gate = deferred();
      gates.set(id, gate);
      await gate.promise;
      return { name: file.name };
    },
  });

  const done = queue.process(files(2));
  await settle();
  for (const gate of gates.values()) gate.resolve();
  await done;

  const last = updates.at(-1);
  assert.equal(last, 1);
  assert.equal(Math.min(...updates), 0);
});

test('one failing file does not stop the batch', async () => {
  const queue = createQueue({
    run: async (file) => {
      if (file.name === 'bad.jpg') throw Object.assign(new Error('nope'), { code: 'DECODE_FAILED' });
      return { name: file.name };
    },
  });
  const state = await queue.process([
    { name: 'good.jpg', size: 1 },
    { name: 'bad.jpg', size: 1 },
    { name: 'also-good.jpg', size: 1 },
  ]);
  assert.equal(state.succeeded, 2);
  assert.equal(state.failed, 1);
  assert.equal(state.items[1].error.code, 'DECODE_FAILED');
  assert.equal(state.items[1].error.message, 'nope');
});

test('cancelling one running item marks it cancelled, and the rest still finish', async () => {
  const queue = createQueue({
    concurrency: 1,
    run: (file, { signal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ name: file.name }), 5);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });

  const added = queue.add(files(2));
  const done = queue.start();
  await settle();
  queue.cancel(added[0].id);
  const state = await done;

  assert.equal(state.items[0].status, 'cancelled');
  assert.equal(state.items[0].error.code, 'ABORTED');
  assert.equal(state.items[1].status, 'done');
});

test('cancelling everything stops queued items from starting', async () => {
  const queue = createQueue({
    concurrency: 1,
    run: (file, { signal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ name: file.name }), 5);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        });
      }),
  });

  queue.add(files(5));
  const done = queue.start();
  await settle();
  queue.cancel();
  const state = await done;

  assert.equal(state.items[0].status, 'cancelled');
  assert.equal(state.succeeded, 0);
  assert.equal(state.cancelled, 5);
});

test('a failed item can be retried', async () => {
  let attempt = 0;
  const queue = createQueue({
    run: async (file) => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('first try fails'), { code: 'INTERNAL' });
      return { name: file.name };
    },
  });

  const [item] = queue.add(files(1));
  await queue.start();
  assert.equal(queue.snapshot().failed, 1);

  const state = await queue.retry(item.id);
  assert.equal(state.succeeded, 1);
  assert.equal(state.items[0].attempts, 2);
});

test('retrying something that is not finished does nothing', async () => {
  const queue = createQueue({ run: async () => ({}) });
  const state = await queue.retry('not-a-job');
  assert.equal(state.total, 0);
});

test('dispose aborts the work in flight and refuses to start anything new', async () => {
  const queue = createQueue({
    concurrency: 1,
    run: (file, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        });
        void file;
      }),
  });

  queue.add(files(3));
  const done = queue.start();
  await settle();
  queue.dispose();
  const state = await done;

  assert.equal(state.succeeded, 0);
  assert.equal(state.cancelled, 3);
});
