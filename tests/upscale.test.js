import test from 'node:test';
import assert from 'node:assert/strict';
import { upscaleSize, upscalePixels } from '../src/assets/js/core/upscale.js';

test('upscale plans exact dimensions and refuses unsafe allocations', () => {
  assert.deepEqual(upscaleSize(320, 240, 4), { width: 1280, height: 960, pixels: 1228800, scale: 4 });
  for (const args of [[100, 100, 3], [4000, 3000, 4], [0, 2, 2], [10000, 1, 1]]) assert.throws(() => upscaleSize(...args));
});
test('bicubic resampling preserves a constant RGBA plane at 2× and 4×', async () => {
  const pixels = new Uint8ClampedArray(8 * 6 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([120, 50, 220, 128], i);
  for (const scale of [2, 4]) {
    const result = await upscalePixels(pixels, 8, 6, scale);
    assert.equal(result.pixels.length, 8 * 6 * scale ** 2 * 4);
    for (let i = 0; i < result.pixels.length; i += 4) assert.deepEqual([...result.pixels.slice(i, i + 4)], [120, 50, 220, 128]);
  }
});
test('transparent colored pixels do not bleed into opaque edges', async () => {
  const { pixels } = await upscalePixels(new Uint8ClampedArray([255, 0, 0, 0, 0, 0, 255, 255]), 2, 1, 4);
  for (let i = 0; i < pixels.length; i += 4) {
    assert.equal(pixels[i], 0);
    if (pixels[i + 3] > 0) assert.ok(pixels[i + 2] >= 254);
  }
});
test('expensive resampling yields and can be cancelled mid-operation', async () => {
  const controller = new AbortController();
  let progressed = false;
  await assert.rejects(upscalePixels(new Uint8ClampedArray(400 * 400 * 4), 400, 400, 4, {
    signal: controller.signal, onProgress: () => { progressed = true; controller.abort(); },
  }), (error) => error.code === 'ABORTED');
  assert.equal(progressed, true);
});
