/**
 * Enhancement engine — two stages, pure pixel math, no DOM and no canvas.
 *
 * Stage A is a per-channel histogram correction: find the black and white points by *percentile*
 * rather than by min/max, then stretch what is left across the full range. Independent per-channel
 * stretch is what removes a colour cast; the percentile is what stops one hot pixel from setting the
 * white point and dragging the whole image down with it.
 *
 * Stage B grades the corrected pixels with one of five presets, and the visitor's intensity slider
 * blends the two stages linearly. 0 % is exactly Stage A's output and 100 % is exactly the preset's —
 * those two endpoints are asserted by `tests/engine-enhance.test.js`, because "the slider slid all
 * the way over" has to mean the same picture as "apply the preset".
 *
 * **The seam.** Everything here is decidable without a browser and runs unchanged under `node --test`.
 * Exactly one step needs a canvas: the four adjustments that CSS `filter` can do on the GPU
 * (brightness, contrast, saturate, grayscale). It arrives as an injected `gradeWithFilter` and the
 * worker supplies it, the same way `engine-compress.js` takes its encoder. When a browser has no
 * `ctx.filter` — Safari before 17.4 — the worker injects nothing and the manual equivalents below
 * run instead, which is why they exist at all rather than being "the fast path plus a shrug".
 *
 * The two paths are equivalent, not bit-identical: measured against each other on a torture ramp they
 * differ by at most 4 code values out of 255, because the canvas implementation carries intermediate
 * precision the byte-accurate fallback cannot. That number is the reason the UI says the fallback is
 * a few code values away rather than claiming the same picture.
 */
import { CompressError } from './errors.js';
import { assertPixelBudget, DEFAULT_MAX_PIXELS } from './engine-compress.js';

export { CompressError };

/** The id that means "Stage A only" — the one-click Auto enhance button, and intensity 0 %. */
export const AUTO_PRESET_ID = 'auto';

/** What a fresh selection starts on: the preset that suits the widest range of photographs. */
export const DEFAULT_PRESET_ID = 'natural';

/**
 * The most a channel may be stretched by. A frame that truly is almost black (0–12) would otherwise be
 * multiplied by 21, and what comes back is sensor noise amplified into coloured mottling that looks
 * far worse than the underexposure it replaced. Six stops of latitude is generous; past it, the honest
 * answer is that the photograph was too dark to save.
 */
export const MAX_GAIN = 6;

/** Pixels clipped at each end before the black/white points are read. 0.4 % ≈ 1k pixels in 640×480. */
export const AUTO_CLIP_PERCENT = 0.004;

/** Below this span a channel is treated as flat: there is nothing to stretch and noise to inflate. */
export const MIN_SPAN = 8;

/**
 * The smallest stretch worth doing. Under 1% the correction cannot move a code value by more than a
 * couple of steps across the whole range, so a channel that only needs that much is left alone rather
 * than reported as "corrected".
 *
 * This is not a hypothetical: the clip reads the black point at 1 and the white point at 254 on a
 * perfect 0–255 ramp, so the span of a photo that already fills its histogram is 253 and the gain
 * would be 1.008× — a real number, an invisible change, and a lie in the result panel.
 */
export const MIN_GAIN = 1.01;

/**
 * The five presets, as named primitives with concrete numbers.
 *
 * Read this as a grading recipe: exposure, then contrast, then the curve, then white balance, then
 * saturation, then the tonal split, then sharpening last — which is the order a colourist works in and
 * the order `applyAdjustments()` applies them. Every value was chosen and then measured against a
 * low-key and a high-key frame.
 *
 * `sharpen.radius` is in pixels of the box blur the unsharp mask subtracts; 1 is a 3×3 neighbourhood.
 */
export const ENHANCE_PRESETS = [
  {
    id: 'natural',
    adjustments: {
      brightness: 1.02,
      contrast: 1.08,
      saturate: 1.1,
      sharpen: { amount: 0.35, radius: 1 },
    },
  },
  {
    id: 'vivid',
    adjustments: {
      brightness: 1.02,
      contrast: 1.22,
      saturate: 1.4,
      temperature: 0.1,
      sharpen: { amount: 0.5, radius: 1 },
    },
  },
  {
    id: 'warm',
    adjustments: {
      brightness: 1.07,
      contrast: 0.95,
      saturate: 1.06,
      temperature: 0.4,
      splitTone: {
        shadows: { r: 8, g: 2, b: -10 },
        highlights: { r: 18, g: 8, b: -22 },
      },
    },
  },
  {
    id: 'cool',
    adjustments: {
      brightness: 0.98,
      contrast: 1.18,
      saturate: 0.85,
      temperature: -0.35,
      splitTone: {
        shadows: { r: -10, g: -2, b: 18 },
        highlights: { r: -6, g: 2, b: 12 },
      },
    },
  },
  {
    /**
     * Grayscale with a real tone curve, and deliberately no colour tint: a warm-toned monochrome is a
     * legitimate darkroom look, but the brief asked for grayscale and this is not the phase to be
     * clever about it. The depth comes from `sCurve`, not from a tint.
     */
    id: 'bw',
    adjustments: {
      brightness: 0.99,
      contrast: 1.06,
      grayscale: 1,
      sCurve: 0.5,
    },
  },
];

/** Lookup by id, with the one failure mode that has a name: an id nothing answers to. */
export function presetById(id) {
  const preset = ENHANCE_PRESETS.find((entry) => entry.id === id);
  if (!preset) {
    throw new CompressError('INVALID_PRESET', `There is no enhancement preset called "${id}".`);
  }
  return preset;
}

/** Clamps an intensity that arrived as a percentage, a fraction, or rubbish. Returns 0–1. */
export function intensityOf(value) {
  if (typeof value === 'string') return intensityOf(Number.parseFloat(value) / (value.includes('%') ? 100 : 1));
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * The visitor's three Advanced sliders, folded into a preset's recipe.
 *
 * Neutral values (1, 1, 0) are the identity, so an untouched Advanced block cannot change a result —
 * and `isNeutralAdvanced()` is what lets the worker skip the merge entirely rather than multiply by
 * 1.0 through a million pixels for nothing.
 */
export const NEUTRAL_ADVANCED = Object.freeze({ brightness: 1, contrast: 1, warmth: 0 });

export function isNeutralAdvanced(advanced) {
  if (!advanced) return true;
  return (
    (advanced.brightness === undefined || advanced.brightness === NEUTRAL_ADVANCED.brightness) &&
    (advanced.contrast === undefined || advanced.contrast === NEUTRAL_ADVANCED.contrast) &&
    (advanced.warmth === undefined || advanced.warmth === NEUTRAL_ADVANCED.warmth)
  );
}

export function composeAdvanced(adjustments, advanced) {
  if (isNeutralAdvanced(advanced)) return adjustments;
  const merged = { ...adjustments };
  if (Number.isFinite(advanced?.brightness)) merged.brightness = (merged.brightness ?? 1) * advanced.brightness;
  if (Number.isFinite(advanced?.contrast)) merged.contrast = (merged.contrast ?? 1) * advanced.contrast;
  if (Number.isFinite(advanced?.warmth)) merged.temperature = (merged.temperature ?? 0) + advanced.warmth;
  return merged;
}

/* ---------- Stage A: the histogram correction ---------- */

/** Three 256-bin histograms, one per channel. Alpha is ignored: nothing here changes opacity. */
export function histogramChannels(pixels, bins = 256) {
  const red = new Uint32Array(bins);
  const green = new Uint32Array(bins);
  const blue = new Uint32Array(bins);
  const scale = bins / 256;

  for (let index = 0; index < pixels.length; index += 4) {
    red[Math.min(bins - 1, Math.floor(pixels[index] * scale))] += 1;
    green[Math.min(bins - 1, Math.floor(pixels[index + 1] * scale))] += 1;
    blue[Math.min(bins - 1, Math.floor(pixels[index + 2] * scale))] += 1;
  }
  return [red, green, blue];
}

/** The value below which `fraction` of the pixels sit, read off a cumulative histogram. */
export function percentileFromHistogram(histogram, fraction) {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;
  const target = fraction * total;
  let cumulative = 0;
  for (let bin = 0; bin < histogram.length; bin += 1) {
    cumulative += histogram[bin];
    if (cumulative >= target) return bin;
  }
  return histogram.length - 1;
}

/**
 * Builds the per-channel stretch as three 256-entry byte tables, plus the numbers the UI reports.
 *
 * The guards are the interesting part: a channel whose usable span is already the whole range gets an
 * identity table (re-stretching it would only amplify quantisation), a channel with almost no span is
 * left alone entirely, and the gain is capped. Each decision lands in `stats` so the page can say what
 * it did instead of claiming a correction it did not make.
 */
export function buildAutoLut(histograms, { clipPercent = AUTO_CLIP_PERCENT, maxGain = MAX_GAIN } = {}) {
  if (!Array.isArray(histograms) || histograms.length !== 3) {
    throw new CompressError('INVALID_INPUT', 'Auto-correct needs one histogram per channel.');
  }

  const lut = new Uint8ClampedArray(768);
  const blackPoint = [0, 0, 0];
  const whitePoint = [255, 255, 255];
  const gains = [1, 1, 1];
  const touched = [false, false, false];

  histograms.forEach((histogram, channel) => {
    const lo = percentileFromHistogram(histogram, clipPercent);
    const hi = percentileFromHistogram(histogram, 1 - clipPercent);
    const span = hi - lo;

    blackPoint[channel] = lo;
    whitePoint[channel] = hi;

    if (span < MIN_SPAN) {
      gains[channel] = 1;
      for (let value = 0; value < 256; value += 1) lut[channel * 256 + value] = value;
      return;
    }

    const gain = Math.min(maxGain, 255 / span);
    if (gain < MIN_GAIN) {
      /*
       * Already the full range, within the tolerance above. An identity table is both the truthful
       * answer and the cheaper one, and because the channel stays out of `channels` the page does not
       * claim a correction nobody could see.
       */
      gains[channel] = 1;
      for (let value = 0; value < 256; value += 1) lut[channel * 256 + value] = value;
      return;
    }

    gains[channel] = Math.round(gain * 1000) / 1000;
    touched[channel] = true;

    for (let value = 0; value < 256; value += 1) {
      lut[channel * 256 + value] = (value - lo) * gain;
    }
  });

  return {
    lut,
    stats: { blackPoint, whitePoint, gains, applied: touched.some(Boolean), channels: touched },
  };
}

/**
 * Applies a prebuilt correction LUT in place.
 *
 * Split out of `autoCorrectPixels()` so a caller that has to build the LUT from a *banded* read of
 * the pixels — the main-thread engine, which accumulates histograms row band by row band instead of
 * holding one decoded frame twice — can apply the correction to each band without rebuilding it.
 * `stats.channels` reports which channels actually moved; the others are left alone.
 */
export function applyAutoLut(pixels, lut, stats) {
  for (const channel of [0, 1, 2]) {
    if (!stats.channels[channel]) continue;
    const offset = channel * 256;
    for (let index = channel; index < pixels.length; index += 4) {
      pixels[index] = lut[offset + pixels[index]];
    }
  }
}

/** Applies the correction in place. Returns the stats, so the caller can report the numbers. */
export function autoCorrectPixels(pixels, options = {}) {
  const { lut, stats } = buildAutoLut(histogramChannels(pixels), options);
  applyAutoLut(pixels, lut, stats);
  return stats;
}

/** Stage A as a one-call function over a pixel buffer, returning a copy plus the stats. */
export function autoCorrect(pixels, options = {}) {
  const copy = new Uint8ClampedArray(pixels);
  return { pixels: copy, correction: autoCorrectPixels(copy, options) };
}

/* ---------- Stage B: grading primitives ---------- */

/**
 * The CSS `filter` string for the four adjustments a canvas can do on the GPU.
 *
 * Only the ones the preset actually asks for appear, and an empty string means "nothing for the fast
 * path to do" rather than an identity filter to draw through.
 */
export function cssFilterFor(adjustments = {}) {
  const parts = [];
  if (Number.isFinite(adjustments.brightness)) parts.push(`brightness(${adjustments.brightness})`);
  if (Number.isFinite(adjustments.contrast)) parts.push(`contrast(${adjustments.contrast})`);
  if (Number.isFinite(adjustments.saturate)) parts.push(`saturate(${adjustments.saturate})`);
  if (Number.isFinite(adjustments.grayscale)) parts.push(`grayscale(${adjustments.grayscale})`);
  return parts.join(' ');
}

/** True when every adjustment is one `ctx.filter` can express — i.e. the manual path has no work. */
export function hasManualWork(adjustments = {}) {
  return (
    Number.isFinite(adjustments.temperature) ||
    Number.isFinite(adjustments.sCurve) ||
    Boolean(adjustments.splitTone) ||
    Boolean(adjustments.sharpen)
  );
}

function clamp255(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * The manual equivalents of the four GPU-able adjustments, per the filter-effects spec's own maths:
 * `brightness` is a linear multiply, `contrast` pivots on 0.5, `saturate` and `grayscale` interpolate
 * against Rec.709 luma. Written down because a browser without `ctx.filter` still has to produce the
 * same picture — the worker's `selfTest()` is what measures how close "the same" actually is: 4 code
 * values out of 255 at worst, which is why the UI says "within a few code values" and not "identical".
 */
export function applyFilterEquivalents(pixels, adjustments = {}) {
  const { brightness, contrast, saturate, grayscale } = adjustments;
  if (
    !Number.isFinite(brightness) &&
    !Number.isFinite(contrast) &&
    !Number.isFinite(saturate) &&
    !Number.isFinite(grayscale)
  ) {
    return pixels;
  }

  for (let index = 0; index < pixels.length; index += 4) {
    let red = pixels[index];
    let green = pixels[index + 1];
    let blue = pixels[index + 2];

    if (Number.isFinite(brightness)) {
      red = clamp255(red * brightness);
      green = clamp255(green * brightness);
      blue = clamp255(blue * brightness);
    }
    if (Number.isFinite(contrast)) {
      red = clamp255((red - 127.5) * contrast + 127.5);
      green = clamp255((green - 127.5) * contrast + 127.5);
      blue = clamp255((blue - 127.5) * contrast + 127.5);
    }
    if (Number.isFinite(saturate) || Number.isFinite(grayscale)) {
      const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      if (Number.isFinite(saturate)) {
        red = clamp255(luma + saturate * (red - luma));
        green = clamp255(luma + saturate * (green - luma));
        blue = clamp255(luma + saturate * (blue - luma));
      }
      if (Number.isFinite(grayscale)) {
        red = clamp255(red + grayscale * (luma - red));
        green = clamp255(green + grayscale * (luma - green));
        blue = clamp255(blue + grayscale * (luma - blue));
      }
    }

    pixels[index] = red;
    pixels[index + 1] = green;
    pixels[index + 2] = blue;
  }
  return pixels;
}

/**
 * The adjustments `ctx.filter` cannot express, applied per pixel: the tone curve, white balance, and
 * the shadow/highlight split. `src` is read and `out` is written, so a caller can hand in the
 * GPU-graded buffer and get a new one back without aliasing.
 */
export function applyManualAdjustments(input, adjustments = {}) {
  const out = new Uint8ClampedArray(input.length);
  out.set(input);

  const { temperature = 0, sCurve = 0, splitTone = null } = adjustments;
  const warmGains = [
    1 + 0.18 * temperature,
    1 + 0.02 * temperature,
    1 - 0.2 * temperature,
  ];
  const toneTouched = sCurve > 0;
  const toneWarm = temperature !== 0;
  const splitTouched = Boolean(splitTone);

  if (!toneTouched && !toneWarm && !splitTouched) return out;

  for (let index = 0; index < out.length; index += 4) {
    let red = out[index];
    let green = out[index + 1];
    let blue = out[index + 2];

    if (toneWarm) {
      red = clamp255(red * warmGains[0]);
      green = clamp255(green * warmGains[1]);
      blue = clamp255(blue * warmGains[2]);
    }

    if (toneTouched) {
      // smoothstep is monotonic over 0–1, so it deepens shadows and lifts highlights without any
      // value crossing another. That is the whole difference between a curve and a flat grey.
      const s = (value) => {
        const x = value / 255;
        return 255 * ((1 - sCurve) * x + sCurve * x * x * (3 - 2 * x));
      };
      red = s(red);
      green = s(green);
      blue = s(blue);
    }

    if (splitTouched) {
      const luma = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
      const shadowWeight = Math.pow(1 - luma, 1.6);
      const highlightWeight = Math.pow(luma, 1.6);
      red = clamp255(red + shadowWeight * (splitTone.shadows?.r ?? 0) + highlightWeight * (splitTone.highlights?.r ?? 0));
      green =
        clamp255(green + shadowWeight * (splitTone.shadows?.g ?? 0) + highlightWeight * (splitTone.highlights?.g ?? 0));
      blue = clamp255(blue + shadowWeight * (splitTone.shadows?.b ?? 0) + highlightWeight * (splitTone.highlights?.b ?? 0));
    }

    out[index] = red;
    out[index + 1] = green;
    out[index + 2] = blue;
  }
  return out;
}

/**
 * Luminance-only unsharp mask.
 *
 * The blur is a separable box filter over a single `Uint8Array` of luma, and the resulting delta is
 * added back to all three channels equally. That keeps a sharpened edge from growing a colour fringe,
 * and it costs two 12 MB planes on a 12 MP photograph instead of the ~150 MB a full RGB float
 * convolution would want.
 *
 * `width` is required because a blur needs to know where rows end. It is passed in rather than
 * inferred: guessing it from the buffer length is only right for a square image, and would blur
 * across row boundaries of everything else.
 */
/**
 * Luminance plane of an RGBA buffer, one byte per pixel.
 *
 * The same extraction `sharpenPixels()` does internally, split out so a caller that already owns
 * the pixels can hand the plane to a banded blur instead of recomputing it.
 */
export function extractLuma(pixels) {
  const luma = new Uint8Array(pixels.length / 4);
  for (let pixel = 0; pixel < luma.length; pixel += 1) {
    const index = pixel * 4;
    luma[pixel] = 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
  }
  return luma;
}

/**
 * Adds a blurred-plane delta back into the colour channels: `out += amount * (luma - blurred)`.
 *
 * Separated from `sharpenPixels()` for the same reason `extractLuma` is: the main-thread engine
 * runs the three steps over row bands, and the delta step is the only one that writes the pixels
 * it was given.
 */
export function applySharpenDelta(pixels, luma, blurred, amount) {
  for (let pixel = 0; pixel < luma.length; pixel += 1) {
    const delta = amount * (luma[pixel] - blurred[pixel]);
    if (delta === 0) continue;
    const index = pixel * 4;
    pixels[index] = clamp255(pixels[index] + delta);
    pixels[index + 1] = clamp255(pixels[index + 1] + delta);
    pixels[index + 2] = clamp255(pixels[index + 2] + delta);
  }
}

export function sharpenPixels(pixels, { amount = 0, radius = 1, width } = {}) {
  if (!(amount > 0) || pixels.length === 0) return pixels;

  const count = pixels.length / 4;
  const columns = Math.round(width);
  if (!Number.isFinite(columns) || columns < 1 || count % columns !== 0) {
    throw new CompressError('INVALID_INPUT', 'Sharpening needs the image width. It was missing or wrong for this pixel buffer.');
  }

  const luma = extractLuma(pixels);
  const blurred = boxBlur(luma, columns, Math.max(1, Math.round(radius)));
  applySharpenDelta(pixels, luma, blurred, amount);
  return pixels;
}

/**
 * Separable box blur with edge clamping. One plane of bytes in, one plane out.
 *
 * Stays on plain arrays and integer width so it is testable in Node with no canvas involved — the
 * only thing it needs to know is where a row ends. The intermediate pass rounds rather than truncates:
 * truncating every intermediate sample biases a blur down by up to a code value.
 *
 * The two passes are exported separately (`boxBlurRows`, `boxBlurCols`) because a box blur is only
 * separable *between* the passes: the horizontal one is a per-row map and the vertical one is a
 * per-column map, so each can run over a band of rows on its own. That is what the main-thread
 * engine needs to stay responsive on a photograph too large to blur synchronously, and `boxBlur`
 * remains the two-pass composition so nothing that calls it changes.
 */
export function boxBlur(source, width, radius) {
  return boxBlurCols(boxBlurRows(source, width, radius), width, radius);
}

/** The horizontal pass: each output row depends only on its own input row. */
export function boxBlurRows(source, width, radius) {
  const height = Math.max(1, Math.round(source.length / width));
  const horizontal = new Uint8Array(source.length);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let hits = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sample = x + offset;
        if (sample < 0 || sample >= width) continue;
        sum += source[row + sample];
        hits += 1;
      }
      horizontal[row + x] = Math.round(sum / hits);
    }
  }
  return horizontal;
}

/** The vertical pass: each output row depends on `radius` rows above and below it. */
export function boxBlurCols(horizontal, width, radius) {
  const height = Math.max(1, Math.round(horizontal.length / width));
  const out = new Uint8Array(horizontal.length);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      let hits = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sample = y + offset;
        if (sample < 0 || sample >= height) continue;
        sum += horizontal[sample * width + x];
        hits += 1;
      }
      out[y * width + x] = Math.round(sum / hits);
    }
  }
  return out;
}

/** Full Stage B: the GPU-able part first (injected), then the manual part, then sharpening. */
export function applyGrade(pixels, adjustments, { gradeWithFilter = null, width } = {}) {
  const filter = cssFilterFor(adjustments);
  let graded = pixels;

  if (gradeWithFilter && filter !== '') {
    graded = gradeWithFilter(pixels, filter);
  } else if (filter !== '') {
    graded = applyFilterEquivalents(new Uint8ClampedArray(pixels), adjustments);
  }

  let out = applyManualAdjustments(graded, adjustments);
  if (adjustments.sharpen) out = sharpenPixels(out, { ...adjustments.sharpen, width });
  return out;
}

/**
 * The intensity blend: `out = base + (styled − base) × t`.
 *
 * Both endpoints are exact rather than approximate — at t = 0 the base buffer is copied, at t = 1 the
 * styled one is — so "0 %" cannot drift a code value away from Auto enhance's own output.
 */
export function blendPixels(base, styled, intensity) {
  const t = intensityOf(intensity);
  const out = new Uint8ClampedArray(styled.length);
  if (t === 0) {
    out.set(base);
    return out;
  }

  for (let index = 0; index < out.length; index += 4) {
    out[index] = base[index] + (styled[index] - base[index]) * t;
    out[index + 1] = base[index + 1] + (styled[index + 1] - base[index + 1]) * t;
    out[index + 2] = base[index + 2] + (styled[index + 2] - base[index + 2]) * t;
    out[index + 3] = styled[index + 3];
  }
  return out;
}

/* ---------- the pipeline ---------- */

/**
 * The whole two-stage pipeline over one pixel buffer.
 *
 * Returns a new buffer plus the metadata the result panel wants: the correction's gains, which grade
 * path ran, and whether anything at all was asked of it.
 *
 * `AUTO_PRESET_ID` means "Stage A alone" — no preset grade, which is what the Auto enhance button
 * resolves to. The Advanced sliders still apply on top of it, because they are a manual override of
 * whatever is selected, including "no style": with them neutral, Auto is exactly Stage A, and nothing
 * runs that could shift a code value away from the histogram stretch.
 *
 * `deps.width` is the image's real width. It is only needed for sharpening, which cannot blur without
 * knowing where rows end.
 */
export function enhancePixels(input, options = {}, deps = {}) {
  const {
    presetId = DEFAULT_PRESET_ID,
    intensity = 1,
    advanced = null,
    autoCorrectOptions = {},
  } = options;

  if (!(input instanceof Uint8ClampedArray)) {
    throw new CompressError('INVALID_INPUT', 'There was no image data to enhance.');
  }
  if (input.length === 0 || input.length % 4 !== 0) {
    throw new CompressError('INVALID_PROBE', 'The image data was not a whole number of RGBA pixels.');
  }

  const { pixels: base, correction } = autoCorrect(input, autoCorrectOptions);

  const autoOnly = presetId === AUTO_PRESET_ID;
  const preset = autoOnly ? { id: AUTO_PRESET_ID, adjustments: {} } : presetById(presetId);
  const adjustments = composeAdvanced(preset.adjustments, advanced);
  const filter = cssFilterFor(adjustments);

  // Auto with neutral Advanced, or a preset dialled to 0 %: both are the auto-corrected image, and
  // both must be returned without being pushed through a single extra arithmetic step.
  const t = autoOnly ? 1 : intensityOf(intensity);
  if (t === 0 || (filter === '' && !hasManualWork(adjustments))) {
    return {
      pixels: base,
      meta: {
        presetId: autoOnly ? AUTO_PRESET_ID : presetId,
        intensity: t,
        styled: false,
        correction,
        gradePath: 'none',
      },
    };
  }

  const styled = applyGrade(base, adjustments, deps);
  const pixels = t === 1 ? styled : blendPixels(base, styled, t);

  return {
    pixels,
    meta: {
      presetId: autoOnly ? AUTO_PRESET_ID : presetId,
      intensity: t,
      styled: true,
      correction,
      gradePath: deps.gradeWithFilter && filter !== '' ? 'filter' : 'manual',
      adjustments,
    },
  };
}

/**
 * Guards the pixel budget the way compress does, and reports the pixel count for the metadata.
 *
 * Whether the output format needs a white backdrop is deliberately not answered here: that is
 * `needsOpaqueBackdrop()` in engine-convert.js, which every canvas-writing worker already uses.
 */
export function assertEnhanceBudget(width, height, maxPixels = DEFAULT_MAX_PIXELS) {
  assertPixelBudget(width, height, maxPixels);
  return { width: Math.round(width), height: Math.round(height), pixels: Math.round(width) * Math.round(height) };
}
