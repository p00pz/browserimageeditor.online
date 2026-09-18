/**
 * Enhancement engine tests.
 *
 * The engine is pure pixel maths, so everything here runs in Node with no canvas at all — which is the
 * property the whole design was built around, and the reason the canvas step is injected rather than
 * called.
 *
 * What these tests are actually protecting:
 *
 *   1. **The two endpoints of the intensity slider.** 0 % must be exactly the auto-corrected photo and
 *      100 % exactly the styled one. `blendPixels` special-cases both, and a regression that turned
 *      0 % into "a very small blend" would be invisible to the eye and wrong in the metadata.
 *   2. **The auto-correct guards.** A channel already spanning the range, a channel with no span at all,
 *      and a channel that would need a 21× gain are each handled differently, and each decision is
 *      reported in `stats` so the page can say what it did rather than claim a correction it skipped.
 *   3. **The presets are distinct.** Five styles that produce the same numbers would pass any test that
 *      only checked one of them.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_CLIP_PERCENT,
  AUTO_PRESET_ID,
  DEFAULT_PRESET_ID,
  ENHANCE_PRESETS,
  MAX_GAIN,
  NEUTRAL_ADVANCED,
  assertEnhanceBudget,
  autoCorrect,
  autoCorrectPixels,
  blendPixels,
  buildAutoLut,
  boxBlur,
  composeAdvanced,
  cssFilterFor,
  enhancePixels,
  hasManualWork,
  histogramChannels,
  intensityOf,
  isNeutralAdvanced,
  percentileFromHistogram,
  presetById,
  sharpenPixels,
} from '../src/assets/js/core/engine-enhance.js';

/** A synthetic RGBA image: `generate(x, y)` returns `[r, g, b]`, alpha is opaque. */
function image(width, height, generate) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const [r, g, b] = generate(x, y);
      pixels[index] = r;
      pixels[index + 1] = g;
      pixels[index + 2] = b;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

/** The mean of one channel, the number a person means by "brighter" or "more red". */
function mean(pixels, channel) {
  let total = 0;
  const count = pixels.length / 4;
  for (let index = channel; index < pixels.length; index += 4) total += pixels[index];
  return total / count;
}

/** A flat grey frame: the degenerate case every guard exists for. */
const FLAT = image(8, 8, () => [128, 128, 128]);

test('a channel that already spans the range is left alone', () => {
  const ramp = image(256, 4, (x) => [x, x, x]);
  const { pixels, correction: stats } = autoCorrect(ramp);

  assert.equal(stats.applied, false, 'nothing to correct, and it says so');
  assert.deepEqual(stats.gains, [1, 1, 1]);
  assert.deepEqual(stats.channels, [false, false, false]);
  /*
   * The strong assertion: the pixels come back untouched. The clip reads the black point at 1 and the
   * white point at 254 on a perfect ramp, so a channel like this one *could* have been "corrected" by
   * 1.008× — a change nobody could see, reported as a correction. It is skipped instead.
   */
  assert.deepEqual([...pixels], [...ramp], 'a full-range frame is returned byte for byte');
  assert.ok(stats.whitePoint[0] - stats.blackPoint[0] >= 250, 'and the reported endpoints are the real ones');
});

test('a flat channel is skipped rather than amplified into noise', () => {
  const { correction: stats } = autoCorrect(FLAT);

  assert.equal(stats.applied, false);
  assert.deepEqual(stats.gains, [1, 1, 1], 'dividing by an almost-zero span is the trap this avoids');
});

test('an underexposed frame is stretched, and the gain is capped', () => {
  // 40–90 out of 255: exactly the mid-dark frame a phone produces under indoor light.
  const dark = image(64, 4, (x) => [40 + Math.round((x / 63) * 50), 40 + Math.round((x / 63) * 50), 40 + Math.round((x / 63) * 50)]);
  const { pixels, correction } = autoCorrect(dark);

  assert.equal(correction.applied, true);
  /*
   * The gain is the formula, not a remembered number: the clip trims a little off both ends of the
   * histogram, so the span it stretches is a couple of code values narrower than the 50 the ramp was
   * drawn across. Asserting against the reported points keeps this test honest about that.
   */
  const span = correction.whitePoint[0] - correction.blackPoint[0];
  assert.equal(correction.gains[0], Math.round((255 / span) * 1000) / 1000);
  assert.ok(correction.gains[0] > 4, `a low-contrast frame gets a real stretch, got ${correction.gains[0]}`);
  assert.ok(mean(pixels, 0) > mean(dark, 0) * 1.5, 'and the picture is visibly brighter for it');

  // The cap. A 0–12 frame would want a 21× gain, which is sensor noise wearing a contrast badge.
  const nearlyBlack = image(64, 4, (x) => [Math.round((x / 63) * 12), Math.round((x / 63) * 12), Math.round((x / 63) * 12)]);
  const capped = autoCorrect(nearlyBlack);
  assert.equal(capped.correction.gains[0], MAX_GAIN, 'the 21× this frame would want is refused');
  // Pixel 3 carries the source value round(3/63×12) = 1, and the table multiplies it by the cap.
  assert.equal(capped.pixels[3 * 4], 1 * MAX_GAIN);
  assert.equal(capped.correction.applied, true, 'capped is still corrected, just not to the full range');
});

test('one hot pixel cannot set the white point', () => {
  // A frame whose real content is 100–160, with a single 255 pixel in the corner — a specular
  // highlight, a stuck sensor, a JPEG ringing artefact.
  const speckled = image(100, 4, (x, y) => {
    if (x === 0 && y === 0) return [255, 255, 255];
    return [100 + Math.round((x / 99) * 60), 100 + Math.round((x / 99) * 60), 100 + Math.round((x / 99) * 60)];
  });

  const { correction: stats, pixels } = autoCorrect(speckled);
  // The white point is the top of the real content, not the speckle: the percentile is the whole
  // reason a single stuck pixel cannot flatten the correction into "do nothing".
  assert.equal(stats.whitePoint[0], 160, 'the hot pixel is outside the clipped tail');
  assert.ok(stats.gains[0] > 4, 'and the frame is still treated as low-contrast rather than as full-range');

  // With the speckle removed, the same frame is corrected on its own merits — which is the actual
  // assertion: the outlier did not drag the correction to the identity.
  const clean = image(100, 4, (x) => [100 + Math.round((x / 99) * 60), 100 + Math.round((x / 99) * 60), 100 + Math.round((x / 99) * 60)]);
  const cleanResult = autoCorrect(clean);
  assert.deepEqual(stats.gains, cleanResult.correction.gains, 'the speckle changed nothing');
  assert.notDeepEqual(pixels, speckled);
});

test('a colour cast is removed by stretching the channels independently', () => {
  // Every channel spans the same ramp, but blue starts 20 lower: the classic tungsten-yellow cast.
  const cast = image(128, 4, (x) => [40 + x, 40 + x, 60 + x]);
  const { pixels, correction } = autoCorrect(cast);

  assert.equal(correction.applied, true, 'independent gains are why a cast is correctable at all');
  assert.ok(correction.blackPoint[2] > correction.blackPoint[0], 'blue started higher and is recorded that way');
  const blueMean = mean(pixels, 2);
  const redMean = mean(pixels, 0);
  assert.ok(Math.abs(blueMean - redMean) < 6, `the cast should be gone: red ${redMean}, blue ${blueMean}`);
});

test('the histogram and percentile helpers agree with a counted answer', () => {
  const histograms = histogramChannels(image(10, 10, () => [200, 100, 50]));
  assert.equal(histograms.length, 3);
  assert.equal(histograms[0][200], 100);
  assert.equal(histograms[1][100], 100);
  assert.equal(histograms[2][50], 100);

  const rampHistogram = new Uint32Array(256).fill(1);
  assert.equal(percentileFromHistogram(rampHistogram, 0), 0);
  // The bin where the cumulative count first *reaches* the fraction: half of 256 is 128, counted at bin 127.
  assert.equal(percentileFromHistogram(rampHistogram, 0.5), 127);
  assert.equal(percentileFromHistogram(rampHistogram, 1), 255);
  assert.equal(percentileFromHistogram(new Uint32Array(256), 0.5), 0, 'an empty histogram is not a division');
});

test('the clip percentage is what the black and white points are read at', () => {
  const { stats } = buildAutoLut(histogramChannels(image(500, 1, (x) => [x < 3 || x > 251 ? 255 : 128, 128, 128])));
  assert.ok(AUTO_CLIP_PERCENT < 0.01, 'the clip stays a small tail, not a crop');
  assert.ok(stats.whitePoint[0] >= 128);
});

test('the intensity endpoints are exact, not approximate', () => {
  const base = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
  const styled = new Uint8ClampedArray([110, 120, 130, 255, 140, 150, 160, 255]);

  const zero = blendPixels(base, styled, 0);
  assert.deepEqual([...zero], [...base], '0% is the base buffer, to the byte');
  assert.deepEqual([...blendPixels(base, styled, 1)], [...styled], 'and 100% is the styled one');

  const half = blendPixels(base, styled, 0.5);
  assert.deepEqual([...half.slice(0, 4)], [60, 70, 80, 255]);
  assert.deepEqual([...blendPixels(base, styled, 0.5)], [...half], 'a repeat of the same call is the same picture');
  assert.equal(intensityOf('50%'), 0.5, 'a percentage string is accepted where a fraction is');
  assert.equal(intensityOf(150), 1, 'and an out-of-range intensity clamps rather than extrapolating');
  assert.equal(intensityOf(-4), 0);
  assert.equal(intensityOf('rubbish'), 1, 'nonsense falls back to the full effect rather than to nothing');
});

test('0% intensity is exactly the auto-corrected photo, through the real pipeline', () => {
  const dark = image(32, 4, (x) => [50 + x, 45 + x, 40 + x]);
  const plain = enhancePixels(dark, { presetId: DEFAULT_PRESET_ID, intensity: 0 }, { width: 32 });
  const auto = enhancePixels(dark, { presetId: AUTO_PRESET_ID }, { width: 32 });

  assert.deepEqual([...plain.pixels], [...auto.pixels], 'the slider at zero and the Auto button are one picture');
  assert.equal(plain.meta.styled, false);
  assert.equal(auto.meta.styled, false);
  assert.equal(auto.meta.gradePath, 'none', 'no grading ran at all, so no arithmetic could drift');
});

test('Auto enhance is Stage A alone, and reports the correction it made', () => {
  const dark = image(32, 4, (x) => [60 + x, 55 + x, 50 + x]);
  const { pixels, meta } = enhancePixels(dark, { presetId: AUTO_PRESET_ID }, { width: 32 });

  assert.equal(meta.presetId, AUTO_PRESET_ID);
  assert.equal(meta.correction.applied, true);
  assert.ok(mean(pixels, 0) > mean(dark, 0), 'the photo comes back brighter');
});

test('the advanced sliders still apply on top of Auto', () => {
  /*
   * The Auto button means "no style", not "ignore my settings". A visitor who moved the Advanced
   * brightness slider and then pressed Auto expects both; the alternative silently discards work.
   */
  const mid = image(16, 4, (x) => [100 + x, 100 + x, 100 + x]);
  const plain = enhancePixels(mid, { presetId: AUTO_PRESET_ID }, { width: 16 });
  const brightened = enhancePixels(
    mid,
    { presetId: AUTO_PRESET_ID, advanced: { brightness: 1.2 } },
    { width: 16 },
  );

  assert.equal(plain.meta.styled, false);
  assert.equal(brightened.meta.styled, true, 'nothing else was asked of it, but this was');
  assert.ok(mean(brightened.pixels, 0) > mean(plain.pixels, 0));
  assert.equal(brightened.meta.presetId, AUTO_PRESET_ID, 'and it is still the Auto style');
});

test('the default preset is one of the five, and every preset is distinct', () => {
  const dark = image(48, 4, (x) => [70 + Math.round(x / 2), 60 + Math.round(x / 3), 90 + Math.round(x / 4)]);
  const signatures = new Map();

  for (const preset of ENHANCE_PRESETS) {
    const { pixels, meta } = enhancePixels(dark, { presetId: preset.id, intensity: 1 }, { width: 48 });
    assert.equal(meta.presetId, preset.id);
    assert.ok(meta.styled || preset.id === AUTO_PRESET_ID, `${preset.id} actually changed something`);
    assert.equal(pixels.length, dark.length, `${preset.id} preserved the buffer size`);

    // Mean channel values are a coarse fingerprint, and coarse is enough: two presets that agree on
    // all three to a tenth of a code value are the same preset with two names.
    const signature = [0, 1, 2].map((channel) => Math.round(mean(pixels, channel) * 10) / 10).join('/');
    assert.equal(signatures.get(signature), undefined, `${preset.id} looks identical to ${signatures.get(signature)}`);
    signatures.set(signature, preset.id);
  }

  assert.equal(signatures.size, ENHANCE_PRESETS.length);
  assert.ok(ENHANCE_PRESETS.some((preset) => preset.id === DEFAULT_PRESET_ID));
  assert.equal(ENHANCE_PRESETS.length, 5, 'the brief asked for five styles');
});

test('the greyscale preset really desaturates, and keeps its depth', () => {
  const colourful = image(64, 4, (x) => [200, 60 + x, 40]);
  const { pixels } = enhancePixels(colourful, { presetId: 'bw', intensity: 1 }, { width: 64 });

  for (let index = 0; index < pixels.length; index += 4) {
    assert.equal(pixels[index], pixels[index + 1], 'every pixel is neutral');
    assert.equal(pixels[index + 1], pixels[index + 2]);
  }
  // And not a flat grey: the tone curve is what makes it look like a photograph instead of a filter.
  const spread = Math.max(...pixels.filter((_, index) => index % 4 === 0)) -
    Math.min(...pixels.filter((_, index) => index % 4 === 0));
  assert.ok(spread > 40, `the monochrome keeps real depth, spread was ${spread}`);
});

test('the warm and cool presets move the picture in opposite directions', () => {
  const neutral = image(32, 4, () => [128, 128, 128]);
  const warm = enhancePixels(neutral, { presetId: 'warm', intensity: 1 }, { width: 32 }).pixels;
  const cool = enhancePixels(neutral, { presetId: 'cool', intensity: 1 }, { width: 32 }).pixels;

  const redBias = (pixels) => mean(pixels, 0) - mean(pixels, 2);
  assert.ok(redBias(warm) > 4, `warm should push red past blue, got ${redBias(warm)}`);
  assert.ok(redBias(cool) < -4, `cool should push blue past red, got ${redBias(cool)}`);
});

test('the four GPU-able adjustments produce a CSS filter, and the rest do not', () => {
  assert.equal(cssFilterFor({}), '', 'nothing asked for means nothing to draw through');
  assert.equal(cssFilterFor({ brightness: 1.02, contrast: 1.08 }), 'brightness(1.02) contrast(1.08)');
  assert.equal(cssFilterFor({ saturate: 1.1, grayscale: 1 }), 'saturate(1.1) grayscale(1)');
  assert.ok(cssFilterFor(presetById('bw').adjustments).includes('grayscale(1)'));

  // The manual half is invisible to `ctx.filter` by design — that is what makes it the manual half.
  assert.equal(hasManualWork({ brightness: 1.1 }), false);
  assert.equal(hasManualWork({ temperature: 0.4 }), true);
  assert.equal(hasManualWork({ sCurve: 0.5 }), true);
  assert.equal(hasManualWork({ splitTone: { shadows: { r: 1, g: 1, b: 1 }, highlights: { r: 0, g: 0, b: 0 } } }), true);
  assert.equal(hasManualWork({ sharpen: { amount: 0.4, radius: 1 } }), true);
});

test('an injected filter path is used when the engine is given one', () => {
  const seen = [];
  const gradeWithFilter = (pixels, filter) => {
    seen.push(filter);
    return new Uint8ClampedArray(pixels);
  };
  const source = image(16, 4, () => [120, 120, 120]);
  const { meta } = enhancePixels(
    source,
    { presetId: 'natural', intensity: 1 },
    { width: 16, gradeWithFilter },
  );

  assert.equal(meta.gradePath, 'filter');
  assert.equal(seen.length, 1, 'the canvas step ran exactly once for the whole grade');
  assert.ok(seen[0].includes('brightness') && seen[0].includes('contrast'));
});

test('without an injected filter the manual equivalents run, and say so', () => {
  const source = image(16, 4, () => [120, 120, 120]);
  const { meta, pixels } = enhancePixels(source, { presetId: 'natural', intensity: 1 }, { width: 16 });

  assert.equal(meta.gradePath, 'manual');
  assert.ok(mean(pixels, 0) > mean(source, 0), 'the manual path is not a no-op');
});

test('sharpening needs the image width, and refuses to guess it', () => {
  const source = image(16, 8, (x) => [100 + (x % 2) * 40, 100, 100]);

  const sharpened = sharpenPixels(new Uint8ClampedArray(source), { amount: 0.5, radius: 1, width: 16 });
  const unsharpened = new Uint8ClampedArray(source);
  assert.notDeepEqual([...sharpened], [...unsharpened], 'an edge gets an edge');

  // A square buffer with no width given: the old code would have inferred 16 and blurred across rows.
  assert.throws(
    () => sharpenPixels(new Uint8ClampedArray(source), { amount: 0.5, radius: 1 }),
    (error) => error.code === 'INVALID_INPUT',
    'a missing width is a programming error, not something to approximate',
  );
  assert.throws(
    () => sharpenPixels(new Uint8ClampedArray(source), { amount: 0.5, radius: 1, width: 7 }),
    (error) => error.code === 'INVALID_INPUT',
    'a width that does not divide the buffer is refused too',
  );

  // Amount 0 is a no-op that must not demand a width at all: nothing to blur.
  assert.deepEqual(
    [...sharpenPixels(new Uint8ClampedArray(source), { amount: 0, width: 16 })],
    [...unsharpened],
  );
});

test('the box blur averages a neighbourhood and leaves the plane the same size', () => {
  const plane = new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]);
  const blurred = boxBlur(plane, 8, 1);
  assert.equal(blurred.length, plane.length);
  assert.ok(blurred[3] > 0 && blurred[3] < 255, 'the seam between black and white is smoothed');
  assert.equal(blurred[7], 255, 'and the edges stay clamped at their own value');

  /*
   * Two passes, so the numbers are not the single-pass ones. Rows are [10,20,30] and [40,50,60]; the
   * horizontal pass gives [15,20,25] and [45,50,55] (each sample averaging only the neighbours that
   * exist, which is what edge clamping means here), and the vertical pass averages those columns.
   */
  const wide = boxBlur(new Uint8Array([10, 20, 30, 40, 50, 60]), 3, 1);
  assert.deepEqual([...wide], [30, 35, 40, 30, 35, 40], 'both passes, with clamped edges');
});

test('the advanced sliders compose multiplicatively, and neutral means untouched', () => {
  assert.equal(isNeutralAdvanced(null), true);
  assert.equal(isNeutralAdvanced({ ...NEUTRAL_ADVANCED }), true);
  assert.equal(isNeutralAdvanced({ warmth: 0.2 }), false);

  const preset = presetById('vivid').adjustments;
  assert.equal(composeAdvanced(preset, { ...NEUTRAL_ADVANCED }), preset, 'neutral returns the same object');
  assert.equal(composeAdvanced(preset, null), preset);

  const brighter = composeAdvanced(preset, { brightness: 2 });
  assert.equal(brighter.brightness, preset.brightness * 2, 'brightness multiplies the preset, it does not replace it');
  assert.equal(brighter.contrast, preset.contrast);

  const warmer = composeAdvanced(preset, { warmth: 0.3 });
  assert.equal(warmer.temperature, (preset.temperature ?? 0) + 0.3, 'warmth adds to the preset temperature');
});

test('an unknown preset is a named failure, not a silent default', () => {
  assert.throws(
    () => presetById('vibrant'),
    (error) => error.code === 'INVALID_PRESET' && error.message.includes('vibrant'),
  );
  assert.throws(
    () => enhancePixels(image(4, 4, () => [1, 2, 3]), { presetId: 'vibrant' }, { width: 4 }),
    (error) => error.code === 'INVALID_PRESET',
  );
});

test('malformed pixel data is rejected before any arithmetic', () => {
  assert.throws(
    () => enhancePixels([1, 2, 3], {}, { width: 1 }),
    (error) => error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => enhancePixels(new Uint8ClampedArray(7), {}, { width: 1 }),
    (error) => error.code === 'INVALID_PROBE',
  );
  assert.throws(
    () => enhancePixels(new Uint8ClampedArray(0), {}, { width: 1 }),
    (error) => error.code === 'INVALID_PROBE',
  );
});

test('the pixel budget is the compress budget, and it reports what it allowed', () => {
  const budget = assertEnhanceBudget(4000, 3000);
  assert.deepEqual(budget, { width: 4000, height: 3000, pixels: 12_000_000 });

  assert.throws(
    () => assertEnhanceBudget(20_000, 20_000),
    (error) => error.code === 'IMAGE_TOO_LARGE',
    'a 400-megapixel image is refused with the message the panel shows',
  );
});

test('the engine never mutates the buffer it was handed', () => {
  const source = image(24, 4, (x) => [40 + x, 50 + x, 60 + x]);
  const before = [...source];
  enhancePixels(source, { presetId: 'vivid', intensity: 1, advanced: { warmth: 0.2 } }, { width: 24 });
  enhancePixels(source, { presetId: AUTO_PRESET_ID }, { width: 24 });
  assert.deepEqual([...source], before, 'the caller keeps its own plane, which the before-numbers are read from');

  const inPlace = image(8, 4, () => [40, 40, 40]);
  autoCorrectPixels(inPlace);
  assert.notDeepEqual([...inPlace], new Array(inPlace.length).fill(40), 'the in-place variant does write');
});
