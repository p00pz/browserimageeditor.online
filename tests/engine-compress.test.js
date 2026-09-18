/**
 * Engine tests. Plain Node, no dependencies and no browser, because engine-compress.js is
 * pure logic that receives its browser capabilities by injection: `probeSize` stands in for
 * createImageBitmap and `imageCompression` for browser-image-compression. Run with `npm test`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompressError,
  DEFAULT_MAX_PIXELS,
  assertPixelBudget,
  compressFile,
  estimateSavings,
  fitWithin,
  flattenForFormat,
  formatLabel,
  libraryOptions,
  parseDimension,
  parseTargetBytes,
} from '../src/assets/js/core/engine-compress.js';
import { DEFAULT_TOLERANCE_RATIO } from '../src/assets/js/core/target-size.js';

/** A stand-in for the browser APIs the worker normally injects. */
function makeDeps({ width = 4000, height = 3000, bytesFor = (quality) => Math.round(1_000_000 * quality), probeError } = {}) {
  const calls = [];
  const deps = {
    probeSize: async () => {
      if (probeError) throw probeError;
      return { width, height };
    },
    imageCompression: async (file, options) => {
      calls.push(options);
      const bytes = Math.max(1, Math.round(bytesFor(options.initialQuality, calls.length)));
      const blob = new Blob([new Uint8Array(bytes)], { type: options.fileType });
      return Object.assign(blob, { name: file?.name ?? 'out' });
    },
  };
  return { calls, deps };
}

function sourceFile(bytes = 4_000_000, name = 'photo.jpg') {
  return Object.assign(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), { name });
}

/* ---------- pure helpers (unchanged since Phase 0) ---------- */

test('fitWithin scales down inside the box and keeps the aspect ratio', () => {
  assert.deepEqual(fitWithin({ width: 4000, height: 3000, maxWidth: 1600 }), {
    width: 1600,
    height: 1200,
    scaled: true,
  });
});

test('fitWithin honours whichever limit binds first', () => {
  assert.deepEqual(fitWithin({ width: 4000, height: 3000, maxWidth: 2000, maxHeight: 600 }), {
    width: 800,
    height: 600,
    scaled: true,
  });
});

test('fitWithin does not enlarge a small image by default', () => {
  assert.deepEqual(fitWithin({ width: 200, height: 100, maxWidth: 1600, maxHeight: 1600 }), {
    width: 200,
    height: 100,
    scaled: false,
  });
});

test('fitWithin can enlarge when noUpscale is disabled', () => {
  assert.deepEqual(fitWithin({ width: 200, height: 100, maxWidth: 400, noUpscale: false }), {
    width: 400,
    height: 200,
    scaled: true,
  });
});

test('fitWithin returns the original size when no limits are given', () => {
  assert.deepEqual(fitWithin({ width: 640, height: 480 }), { width: 640, height: 480, scaled: false });
});

test('fitWithin never collapses an extreme ratio to zero', () => {
  const result = fitWithin({ width: 4000, height: 10, maxWidth: 1 });
  assert.ok(result.width >= 1);
  assert.ok(result.height >= 1);
});

test('fitWithin rejects non-positive source dimensions', () => {
  assert.throws(() => fitWithin({ width: 0, height: 100 }), (error) => error.code === 'INVALID_DIMENSIONS');
  assert.throws(() => fitWithin({ width: Number.NaN, height: 100 }), (error) => error.code === 'INVALID_DIMENSIONS');
});

test('flattenForFormat flags the formats that cannot store alpha', () => {
  assert.equal(flattenForFormat('image/jpeg'), true);
  assert.equal(flattenForFormat('image/webp'), false);
  assert.equal(flattenForFormat('image/png'), false);
});

test('formatLabel falls back to an uppercased subtype', () => {
  assert.equal(formatLabel('image/webp'), 'WebP');
  assert.equal(formatLabel('image/heic'), 'HEIC');
});

test('estimateSavings reports bytes and a rounded percentage', () => {
  assert.deepEqual(estimateSavings(1_000_000, 250_000), { bytes: 750_000, percent: 75 });
  assert.equal(estimateSavings(1_000_000, 2_000_000).percent, -100);
});

test('estimateSavings refuses to divide by a zero-length original', () => {
  assert.deepEqual(estimateSavings(0, 500), { bytes: 0, percent: 0 });
});

test('parseTargetBytes converts kilobytes and treats blank as no target', () => {
  assert.equal(parseTargetBytes('500'), 512_000);
  assert.equal(parseTargetBytes(''), null);
  assert.equal(parseTargetBytes('   '), null);
  assert.equal(parseTargetBytes(null), null);
  assert.equal(parseTargetBytes(undefined), null);
});

test('parseTargetBytes rejects nonsense values', () => {
  assert.throws(() => parseTargetBytes('0'), (error) => error.code === 'INVALID_TARGET');
  assert.throws(() => parseTargetBytes('-4'), (error) => error.code === 'INVALID_TARGET');
  assert.throws(() => parseTargetBytes('abc'), (error) => error.code === 'INVALID_TARGET');
});

test('parseDimension rounds and treats blank as keep-original', () => {
  assert.equal(parseDimension('1600'), 1600);
  assert.equal(parseDimension(1600.6), 1601);
  assert.equal(parseDimension(''), null);
  assert.throws(() => parseDimension('0'), (error) => error.code === 'INVALID_DIMENSION');
});

test('assertPixelBudget allows a normal image and rejects an enormous one', () => {
  assert.doesNotThrow(() => assertPixelBudget(4000, 3000));
  assert.throws(() => assertPixelBudget(20_000, 20_000), (error) => error.code === 'IMAGE_TOO_LARGE');
  assert.equal(typeof DEFAULT_MAX_PIXELS, 'number');
});

/* ---------- libraryOptions ---------- */

test('libraryOptions drives one encode at one quality, off the main thread', () => {
  const options = libraryOptions({
    outputMime: 'image/jpeg',
    fitted: { width: 1600, height: 1200, scaled: true },
    quality: 0.8,
  });
  assert.equal(options.fileType, 'image/jpeg');
  assert.equal(options.initialQuality, 0.8);
  assert.equal(options.maxIteration, 1);
  assert.equal(options.useWebWorker, false);
  assert.equal(options.maxWidthOrHeight, 1600);
});

test('libraryOptions never lets the library import itself from a CDN', () => {
  const options = libraryOptions({ quality: 0.5 });
  assert.equal(options.useWebWorker, false);
  assert.equal('libURL' in options, false);
});

test('libraryOptions sends a max size only when the image is actually being scaled', () => {
  const unscaled = libraryOptions({ fitted: { width: 4000, height: 3000, scaled: false }, quality: 0.9 });
  assert.equal('maxWidthOrHeight' in unscaled, false);
  const missing = libraryOptions({ fitted: null, quality: 0.9 });
  assert.equal('maxWidthOrHeight' in missing, false);
});

test('libraryOptions leaves the canvas-size safety net alone', () => {
  // alwaysKeepResolution would stop the library clamping to the browser's maximum canvas
  // size, which is the one memory guard mobile Safari relies on.
  const options = libraryOptions({ quality: 0.9 });
  assert.equal('alwaysKeepResolution' in options, false);
});

test('libraryOptions clamps quality and only passes a signal when there is one', () => {
  assert.equal(libraryOptions({ quality: 5 }).initialQuality, 1);
  assert.equal(libraryOptions({ quality: -1 }).initialQuality, 0);
  assert.equal(libraryOptions({ quality: Number.NaN }).initialQuality, 1);
  assert.equal('signal' in libraryOptions({ quality: 0.5 }), false);

  const controller = new AbortController();
  assert.equal(libraryOptions({ quality: 0.5, signal: controller.signal }).signal, controller.signal);
});

/* ---------- compressFile ---------- */

test('compressFile needs its browser capabilities injected', async () => {
  await assert.rejects(() => compressFile(sourceFile(), {}), (error) => error.code === 'INVALID_ENCODER');
  await assert.rejects(
    () => compressFile(sourceFile(), {}, { imageCompression: async () => null }),
    (error) => error.code === 'INVALID_PROBE',
  );
});

test('compressFile refuses an empty file', async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => compressFile(new Blob([]), {}, deps),
    (error) => error.code === 'INVALID_INPUT',
  );
});

test('compressFile reports a decode failure instead of throwing raw', async () => {
  const { deps } = makeDeps({ probeError: new Error('not an image') });
  await assert.rejects(
    () => compressFile(sourceFile(), {}, deps),
    (error) => error instanceof CompressError && error.code === 'DECODE_FAILED',
  );
});

test('compressFile refuses an image beyond the pixel budget', async () => {
  const { deps } = makeDeps({ width: 20_000, height: 20_000 });
  await assert.rejects(
    () => compressFile(sourceFile(), {}, deps),
    (error) => error.code === 'IMAGE_TOO_LARGE',
  );
});

test('with no target, compressFile encodes once at the best quality', async () => {
  const { calls, deps } = makeDeps();
  const result = await compressFile(sourceFile(), {}, deps);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].initialQuality, 0.95);
  assert.ok(result.blob instanceof Blob);
  assert.equal(result.meta.status, 'hit');
  assert.equal(result.meta.bytes, result.blob.size);
  assert.equal(result.meta.sourceBytes, 4_000_000);
  assert.equal(result.meta.sourceWidth, 4000);
  assert.equal(result.meta.width, 4000);
  assert.equal(result.meta.scaled, false);
  assert.equal(result.meta.targetBytes, null);
});

test('compressFile hits a target size and reports the file it produced', async () => {
  // A 120 KB image at quality 1: a 100 KB target is reachable, but not at the top quality,
  // so this exercises the bisection rather than the short-circuit.
  const { deps } = makeDeps({ bytesFor: (quality) => Math.round(120_000 * quality) });
  const target = 100 * 1024;
  const result = await compressFile(sourceFile(), { targetBytes: target }, deps);

  assert.equal(result.meta.status, 'hit');
  assert.ok(result.meta.bytes <= target, `expected <= ${target} bytes, got ${result.meta.bytes}`);
  assert.equal(result.meta.targetBytes, target);
  assert.equal(result.meta.toleranceBytes, Math.round(target * DEFAULT_TOLERANCE_RATIO));
  assert.ok(result.meta.attempts >= 2);
});

test('compressFile reports an unreachable target with the shortfall', async () => {
  const { deps } = makeDeps();
  const result = await compressFile(sourceFile(), { targetBytes: 100 * 1024 }, deps);
  assert.equal(result.meta.status, 'unreachable');
  assert.equal(result.meta.overByBytes, 300_000 - 102_400);
  assert.equal(result.meta.quality, 0.3);
});

test('compressFile reports a near miss inside the tolerance', async () => {
  const { deps } = makeDeps();
  const result = await compressFile(sourceFile(), { targetBytes: 299_000 }, deps);
  assert.equal(result.meta.status, 'near');
  assert.ok(result.meta.overByBytes > 0);
  assert.ok(result.meta.overByBytes <= result.meta.toleranceBytes);
});

test('compressFile passes the fitted longest side to the encoder when scaling', async () => {
  const { calls, deps } = makeDeps();
  const result = await compressFile(sourceFile(), { maxWidth: 1600, maxHeight: 600 }, deps);

  assert.equal(result.meta.width, 800);
  assert.equal(result.meta.height, 600);
  assert.equal(result.meta.scaled, true);
  assert.equal(calls[0].maxWidthOrHeight, 800);
});

test('compressFile asks for no resize when the limits are larger than the image', async () => {
  const { calls, deps } = makeDeps();
  const result = await compressFile(sourceFile(), { maxWidth: 8000 }, deps);

  assert.equal(result.meta.scaled, false);
  assert.equal('maxWidthOrHeight' in calls[0], false);
});

test('compressFile forwards the output mime and flags transparency loss', async () => {
  const { calls, deps } = makeDeps();
  const result = await compressFile(sourceFile(), { outputMime: 'image/jpeg' }, deps);
  assert.equal(calls[0].fileType, 'image/jpeg');
  assert.equal(result.meta.outputMime, 'image/jpeg');
  assert.equal(result.meta.flatten, true);
});

test('compressFile reports progress from probe to encode', async () => {
  const phases = [];
  const { deps } = makeDeps();
  await compressFile(
    sourceFile(),
    { targetBytes: 100 * 1024, onProgress: (update) => phases.push(update.phase) },
    deps,
  );

  assert.equal(phases[0], 'probe');
  assert.equal(phases[1], 'fit');
  assert.equal(phases.at(-1), 'encode');
  assert.ok(phases.filter((phase) => phase === 'search').length >= 2);
});

test('compressFile rejects an encoder that returns nothing usable', async () => {
  const deps = { probeSize: async () => ({ width: 100, height: 100 }), imageCompression: async () => null };
  await assert.rejects(
    () => compressFile(sourceFile(), {}, deps),
    (error) => error.code === 'ENCODE_FAILED',
  );
});

test('compressFile stops when the signal is already aborted', async () => {
  const { deps } = makeDeps();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => compressFile(sourceFile(), { targetBytes: 100 * 1024, signal: controller.signal }, deps),
    (error) => error.code === 'ABORTED',
  );
});
