/**
 * Resize planning and the preset table. Run with `npm test`.
 *
 * The preset tests are really a data audit: they catch a typo'd pixel value or a duplicated id
 * before it reaches a select box, and they pin the two YouTube numbers to the values Google's own
 * help page documents.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { planResize, scalePercent } from '../src/assets/js/core/engine-resize.js';
import {
  CROP_RATIOS,
  RESIZE_PRESETS,
  findCropRatio,
  findResizePreset,
  groupedResizePresets,
} from '../src/assets/js/core/presets.js';
import { CompressError } from '../src/assets/js/core/errors.js';

test('the aspect-locked plan fits inside the box and keeps the ratio', () => {
  assert.deepEqual(planResize({ sourceWidth: 4000, sourceHeight: 3000, targetWidth: 1600 }), {
    width: 1600,
    height: 1200,
    scaled: true,
    ratio: 0.4,
  });
});

test('the box that binds first is the one that decides', () => {
  const plan = planResize({ sourceWidth: 4000, sourceHeight: 3000, targetWidth: 2000, targetHeight: 600 });
  assert.deepEqual({ width: plan.width, height: plan.height }, { width: 800, height: 600 });
});

test('a square box does not squash a landscape photo', () => {
  const plan = planResize({ sourceWidth: 4000, sourceHeight: 3000, targetWidth: 1000, targetHeight: 1000 });
  assert.deepEqual({ width: plan.width, height: plan.height }, { width: 1000, height: 750 });
});

test('a small image is left alone unless enlarging is allowed', () => {
  assert.deepEqual(planResize({ sourceWidth: 200, sourceHeight: 100, targetWidth: 1600 }), {
    width: 200,
    height: 100,
    scaled: false,
    ratio: 1,
  });
  assert.deepEqual(planResize({ sourceWidth: 200, sourceHeight: 100, targetWidth: 1600, allowUpscale: true }), {
    width: 1600,
    height: 800,
    scaled: true,
    ratio: 8,
  });
});

test('no target means the original dimensions, untouched', () => {
  assert.deepEqual(planResize({ sourceWidth: 640, sourceHeight: 480 }), {
    width: 640,
    height: 480,
    scaled: false,
    ratio: 1,
  });
});

test('unlocking the ratio sets exactly what was typed, filling a blank axis from the original', () => {
  const both = planResize({ sourceWidth: 4000, sourceHeight: 3000, targetWidth: 640, targetHeight: 640, lockAspect: false });
  assert.deepEqual({ width: both.width, height: both.height, scaled: both.scaled }, { width: 640, height: 640, scaled: true });

  const one = planResize({ sourceWidth: 4000, sourceHeight: 3000, targetWidth: 800, lockAspect: false });
  assert.deepEqual({ width: one.width, height: one.height }, { width: 800, height: 3000 });
});

test('an extreme ratio never collapses to zero pixels', () => {
  const plan = planResize({ sourceWidth: 4000, sourceHeight: 10, targetWidth: 1 });
  assert.ok(plan.width >= 1 && plan.height >= 1);
});

test('nonsense dimensions fail with a message that names the axis', () => {
  assert.throws(
    () => planResize({ sourceWidth: 100, sourceHeight: 100, targetWidth: '0' }),
    (error) => error instanceof CompressError && error.code === 'INVALID_DIMENSION' && /width/.test(error.message),
  );
  assert.throws(
    () => planResize({ sourceWidth: 100, sourceHeight: 100, targetHeight: 'abc' }),
    (error) => error.code === 'INVALID_DIMENSION' && /height/.test(error.message),
  );
  assert.throws(() => planResize({ sourceWidth: 0, sourceHeight: 100 }), (error) => error.code === 'INVALID_DIMENSIONS');
});

test('scalePercent reports area removed, and goes negative when the image grows', () => {
  assert.equal(scalePercent(4000, 3000, 2000, 1500), 75);
  assert.equal(scalePercent(100, 100, 200, 200), -300);
  assert.equal(scalePercent(0, 0, 10, 10), 0);
});

/* ---------- preset data ---------- */

test('every resize preset is usable and identifiable', () => {
  const ids = RESIZE_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, 'preset ids must be unique');

  for (const preset of RESIZE_PRESETS) {
    assert.ok(Number.isInteger(preset.width) && preset.width > 0, `${preset.id} needs a positive integer width`);
    assert.ok(Number.isInteger(preset.height) && preset.height > 0, `${preset.id} needs a positive integer height`);
    assert.ok(typeof preset.label === 'string' && preset.label.length > 0);
    assert.ok(typeof preset.source === 'string' && preset.source.length > 10, `${preset.id} must record where the number came from`);
    assert.equal(typeof preset.derived, 'boolean', `${preset.id} must say whether the number is derived or quoted`);
  }
});

test("the YouTube presets match Google's published numbers", () => {
  const thumbnail = findResizePreset('youtube-thumbnail');
  const shorts = findResizePreset('youtube-shorts-cover');
  // support.google.com/youtube/answer/72431: "3840 x 2160 pixels for videos and 2160 x 3840 for Shorts".
  assert.deepEqual({ w: thumbnail.width, h: thumbnail.height }, { w: 3840, h: 2160 });
  assert.deepEqual({ w: shorts.width, h: shorts.height }, { w: 2160, h: 3840 });
  assert.match(thumbnail.source, /support\.google\.com/);
  assert.equal(thumbnail.derived, false, 'a quoted number is not derived');
});

test('the Instagram presets are marked derived, because the platform publishes ratios rather than pixels', () => {
  const instagram = RESIZE_PRESETS.filter((preset) => preset.group === 'Instagram');
  assert.equal(instagram.length, 4);
  assert.ok(instagram.every((preset) => preset.derived), 'these are arithmetic on published ratios');
  assert.ok(instagram.every((preset) => !/https?:/.test(preset.source)), 'no guessed documentation URL');
  assert.equal(findResizePreset('instagram-portrait').ratio, '4:5');
});

test('presets group in the order they are declared, and lookups miss safely', () => {
  const groups = groupedResizePresets();
  assert.deepEqual(
    groups.map((group) => group.name),
    ['Instagram', 'YouTube', 'General'],
  );
  assert.equal(groups.reduce((total, group) => total + group.presets.length, 0), RESIZE_PRESETS.length);
  assert.equal(findResizePreset('nope'), null);
  assert.equal(findCropRatio('nope'), null);
});

test('crop ratios are real ratios, and only "free" is unconstrained', () => {
  const free = CROP_RATIOS.filter((preset) => preset.ratio === null);
  assert.deepEqual(free.map((preset) => preset.id), ['free']);
  for (const preset of CROP_RATIOS.filter((entry) => entry.ratio !== null)) {
    assert.ok(preset.ratio > 0 && Number.isFinite(preset.ratio), `${preset.id} needs a positive ratio`);
  }
  assert.equal(findCropRatio('wide').ratio, 16 / 9);
});
