/**
 * Target-size search tests. Plain Node, no dependencies — the encoder is injected, so the
 * whole search runs without a browser. Run with `npm test`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CompressError } from '../src/assets/js/core/errors.js';
import {
  DEFAULT_TOLERANCE_RATIO,
  QUALITY_SEARCH_DEFAULTS,
  searchTargetBytes,
  toleranceFor,
} from '../src/assets/js/core/target-size.js';

/** Encoder whose byte size is proportional to quality, so the search is predictable. */
function fakeEncoder(factor = 1_000_000) {
  return async (quality) => ({ bytes: Math.round(factor * quality), blob: { quality } });
}

test('toleranceFor defaults to 2% of the target, with a 256-byte floor', () => {
  assert.equal(toleranceFor(100 * 1024), Math.round(100 * 1024 * DEFAULT_TOLERANCE_RATIO));
  assert.equal(toleranceFor(1_000), 256);
  assert.equal(toleranceFor(100 * 1024, 4_096), 4_096);
  assert.equal(toleranceFor(null), 0);
});

test('no target means a single encode at maximum quality', async () => {
  const result = await searchTargetBytes({ encode: fakeEncoder(), targetBytes: null });
  assert.equal(result.status, 'hit');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.quality, QUALITY_SEARCH_DEFAULTS.maxQuality);
  assert.equal(result.targetBytes, null);
  assert.ok(result.blob);
});

test('a target max quality already meets is a hit after one encode', async () => {
  const result = await searchTargetBytes({ encode: fakeEncoder(), targetBytes: 1_000_000 });
  assert.equal(result.status, 'hit');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.quality, QUALITY_SEARCH_DEFAULTS.maxQuality);
  assert.ok(result.bytes <= 1_000_000);
});

test('the search converges under the target without dropping to the floor', async () => {
  const result = await searchTargetBytes({ encode: fakeEncoder(), targetBytes: 500_000 });
  assert.equal(result.status, 'hit');
  assert.ok(result.bytes <= 500_000, `expected <= 500000 bytes, got ${result.bytes}`);
  assert.ok(
    result.quality > QUALITY_SEARCH_DEFAULTS.minQuality,
    `expected a better quality than the floor, got ${result.quality}`,
  );
  assert.ok(result.attempts.length <= 10, `expected a bounded number of encodes, got ${result.attempts.length}`);
  assert.ok(result.blob, 'the winning encode should be handed back so it is not repeated');
  assert.equal(result.overByBytes, 0);
});

test('a hit never exceeds the target, whatever the target is', async () => {
  const encoder = fakeEncoder();
  for (const target of [320_000, 400_000, 640_000, 940_000]) {
    const result = await searchTargetBytes({ encode: encoder, targetBytes: target });
    assert.equal(result.status, 'hit');
    assert.ok(result.bytes <= target, `target ${target} produced ${result.bytes} bytes`);
  }
});

test('a target below the smallest achievable size is never called a hit', async () => {
  const encoder = fakeEncoder();
  // The floor encode is 300 KB, so none of these can be reached — and none may claim to be.
  for (const target of [40_000, 120_000, 280_000]) {
    const result = await searchTargetBytes({ encode: encoder, targetBytes: target });
    assert.notEqual(result.status, 'hit');
    assert.ok(result.bytes > target, `target ${target} produced ${result.bytes} bytes`);
    assert.equal(result.quality, QUALITY_SEARCH_DEFAULTS.minQuality);
  }
});

test('a target far out of reach is reported as unreachable with the shortfall', async () => {
  const result = await searchTargetBytes({ encode: fakeEncoder(), targetBytes: 1_000 });
  assert.equal(result.status, 'unreachable');
  assert.equal(result.quality, QUALITY_SEARCH_DEFAULTS.minQuality);
  assert.equal(result.bytes, 300_000);
  assert.equal(result.overByBytes, 299_000);
  assert.deepEqual(result.blob, { quality: QUALITY_SEARCH_DEFAULTS.minQuality });
  assert.equal(result.attempts.length, 2);
});

test('missing the target by less than the tolerance is reported as near, not unreachable', async () => {
  // Floor output is 300 KB, so a 299 KB target lands 1 KB over — inside the 2% tolerance.
  const result = await searchTargetBytes({ encode: fakeEncoder(), targetBytes: 299_000 });
  assert.equal(result.status, 'near');
  assert.equal(result.overByBytes, 1_000);
  assert.ok(result.overByBytes <= result.toleranceBytes);
});

test('an explicit tolerance overrides the default', async () => {
  const strict = await searchTargetBytes({ encode: fakeEncoder(), targetBytes: 299_000, toleranceBytes: 10 });
  assert.equal(strict.status, 'unreachable');
  const generous = await searchTargetBytes({ encode: fakeEncoder(), targetBytes: 290_000, toleranceBytes: 20_000 });
  assert.equal(generous.status, 'near');
});

test('every attempt is reported to onAttempt in order', async () => {
  const seen = [];
  const result = await searchTargetBytes({
    encode: fakeEncoder(),
    targetBytes: 500_000,
    onAttempt: (attempt) => seen.push(attempt),
  });
  assert.equal(seen.length, result.attempts.length);
  assert.deepEqual(
    seen.map((attempt) => attempt.attempt),
    seen.map((_, index) => index + 1),
  );
});

test('an already-aborted signal stops the search before any encode', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => searchTargetBytes({ encode: fakeEncoder(), targetBytes: 500_000, signal: controller.signal }),
    (error) => error instanceof CompressError && error.code === 'ABORTED',
  );
});

test('cancelling mid-search rejects with ABORTED', async () => {
  const controller = new AbortController();
  const encode = async (quality) => {
    controller.abort();
    return { bytes: Math.round(1_000_000 * quality), blob: { quality } };
  };
  await assert.rejects(
    () => searchTargetBytes({ encode, targetBytes: 500_000, signal: controller.signal }),
    (error) => error.code === 'ABORTED',
  );
});

test('a missing or malformed encoder is rejected', async () => {
  await assert.rejects(
    () => searchTargetBytes({ targetBytes: 500_000 }),
    (error) => error.code === 'INVALID_ENCODE',
  );
  await assert.rejects(
    () => searchTargetBytes({ targetBytes: 500_000, encode: async () => null }),
    (error) => error.code === 'INVALID_ENCODE_RESULT',
  );
});
