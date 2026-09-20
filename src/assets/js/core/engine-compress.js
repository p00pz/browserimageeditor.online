/**
 * Compression engine — pure logic, no DOM and no dependencies of its own.
 *
 * Everything decidable without a browser lives here: parsing what a person typed, choosing
 * output dimensions, budgeting pixels, mapping our options onto the encoder's, and driving a
 * target-size search. The two things that *do* need a browser are injected by
 * ../workers/compress.worker.js:
 *
 *   - `imageCompression` — the browser-image-compression function. It is imported by the
 *     worker rather than here, because importing a browser-only module here would drag it
 *     into `node --test` and take the engine tests down with it.
 *   - `probeSize` — `createImageBitmap`, for the source dimensions and the pixel budget.
 *
 * That seam is the Phase 0 pattern: one module that can be tested in plain Node, one worker
 * that owns every browser API.
 */
import { CompressError } from './errors.js';
import { flattenForFormat } from './formats.js';
import { searchTargetBytes } from './target-size.js';

export { CompressError };

/**
 * The format facts moved to ./formats.js in Phase 3, where the convert, resize and crop tools can
 * reach them without importing this file. They are re-exported so nothing else had to change.
 */
export { flattenForFormat, formatLabel } from './formats.js';

/** Canvas dimensions beyond this are likely to exhaust browser memory, so we refuse early. */
export const DEFAULT_MAX_PIXELS = 100_000_000;

/**
 * WebKit — every browser on iOS, and Safari on macOS — caps the total *area* of a canvas well
 * below the general budget. Allocating past the cap fails outright instead of swapping to disk, so
 * on those browsers the usable budget is the smaller number. ~16.7 megapixels is the observed
 * ceiling for a single canvas on iOS.
 */
export const WEBKIT_SAFE_MAX_PIXELS = 16_700_000;

/**
 * Detects a WebKit-based browser from its user agent.
 *
 * There is no capability probe for "can a canvas this large exist" — the only way to ask is to try,
 * and trying is the crash — so the user agent decides it. Every browser on iOS is WebKit under the
 * hood regardless of its own brand, so the whole family shares the limit. On macOS the other
 * vendors' tokens are what rule them out: Chrome, Edge, Opera, Firefox and every Android browser
 * carry one even when their UA also says "Safari".
 */
export function isWebKitAgent(userAgent = '') {
  const ua = String(userAgent ?? '').toLowerCase();
  if (/(?:iphone|ipad|ipod)/.test(ua)) return true;
  return ua.includes('safari') && !/(?:chrom|android|firefox|edg|opr)/.test(ua);
}

/**
 * The pixel budget that applies on this device: the configured budget, or the WebKit canvas cap,
 * whichever is smaller. The user agent is a parameter rather than read here because the pure
 * engines are tested in Node, where there is no navigator; the workers that call them pass theirs.
 */
export function safeMaxPixels(maxPixels = DEFAULT_MAX_PIXELS, userAgent = '') {
  const configured = Number.isFinite(maxPixels) && maxPixels > 0 ? maxPixels : DEFAULT_MAX_PIXELS;
  if (!isWebKitAgent(userAgent)) return configured;
  return Math.min(configured, WEBKIT_SAFE_MAX_PIXELS);
}

/**
 * Scales a pair of dimensions down until the pixel count fits a budget, keeping the aspect ratio.
 *
 * Used when a photo is larger than this device can hold on a canvas at all: rather than refusing a
 * photo the visitor can see, the compress engine shrinks the source to something that fits and
 * reports the real numbers, so the page can say exactly what happened and why.
 */
export function fitToPixelBudget(width, height, maxPixels) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w * h <= maxPixels) return { width: w, height: h, scaled: false };
  // The square root of the area ratio is the linear scale, and flooring both axes keeps the
  // product on the safe side of the budget.
  const ratio = Math.sqrt(maxPixels / (w * h));
  return {
    width: Math.max(1, Math.floor(w * ratio)),
    height: Math.max(1, Math.floor(h * ratio)),
    scaled: true,
  };
}

/**
 * The two typed-number parsers now live in ./inputs.js because resize, convert and crop all
 * need them. They are re-exported here so every existing import keeps working unchanged.
 */
export { parseDimension, parseTargetBytes } from './inputs.js';

/**
 * Computes the output pixel dimensions inside the requested box, preserving aspect ratio.
 * `noUpscale` keeps a small image from being enlarged to fill the box.
 *
 * This stays the sizing authority even though the encoder can resize too: the encoder takes
 * a single max width/height, while the page offers two separate limits.
 */
export function fitWithin({ width, height, maxWidth = null, maxHeight = null, noUpscale = true } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new CompressError('INVALID_DIMENSIONS', 'The image reported non-positive dimensions and cannot be processed.');
  }

  const ratios = [];
  if (Number.isFinite(maxWidth) && maxWidth > 0) ratios.push(maxWidth / width);
  if (Number.isFinite(maxHeight) && maxHeight > 0) ratios.push(maxHeight / height);

  if (ratios.length === 0) {
    return { width: Math.round(width), height: Math.round(height), scaled: false };
  }

  let ratio = Math.min(...ratios);
  if (noUpscale && ratio > 1) ratio = 1;
  if (ratio === 1) {
    return { width: Math.round(width), height: Math.round(height), scaled: false };
  }

  const scaledWidth = Math.max(1, Math.round(width * ratio));
  const scaledHeight = Math.max(1, Math.round(height * ratio));
  return {
    width: scaledWidth,
    height: scaledHeight,
    scaled: scaledWidth !== width || scaledHeight !== height,
  };
}

/**
 * The user agent of the current document, or '' where there is none (a plain Node test). Used as
 * the default so a call site that passes nothing still gets the platform's real canvas limit in a
 * browser, while the pure engine tests keep their deterministic desktop budget.
 */
function liveUserAgent() {
  if (typeof navigator === 'undefined') return '';
  return navigator.userAgent ?? '';
}

/**
 * Refuses dimensions whose pixel count no canvas on this device can hold.
 *
 * Without an explicit budget the safe one for the platform is used, which is what guards the
 * engines that never see a user agent of their own.
 */
export function assertPixelBudget(width, height, maxPixels = safeMaxPixels(liveUserAgent())) {
  const pixels = width * height;
  if (pixels > maxPixels) {
    throw new CompressError(
      'IMAGE_TOO_LARGE',
      `That image is about ${Math.round(pixels / 1_000_000)} megapixels. The limit is ` +
        `${Math.round(maxPixels / 1_000_000)} megapixels, because a canvas that large can ` +
        'exhaust the browser memory. Shrink it first, then compress.',
    );
  }
}

/** Bytes and percentage saved; the percentage goes negative if the file grew. */
export function estimateSavings(originalBytes, resultBytes) {
  if (!Number.isFinite(originalBytes) || originalBytes <= 0 || !Number.isFinite(resultBytes)) {
    return { bytes: 0, percent: 0 };
  }
  const bytes = originalBytes - resultBytes;
  return { bytes, percent: Math.round((bytes / originalBytes) * 1000) / 10 };
}

function clampQuality(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/**
 * Maps our options onto browser-image-compression's.
 *
 * Three of these are load-bearing:
 *   - `useWebWorker: false`. The library defaults to true and, in that mode, imports itself
 *     into its own worker from its `libURL` default — a jsdelivr CDN URL. That would be a
 *     third-party request from every visitor's browser on a site whose whole pitch is that
 *     nothing leaves the device, so we never let it happen. We are already inside a worker.
 *   - `maxIteration: 1`, because *we* drive the iteration: one call must mean exactly one
 *     encode at exactly one quality, or the binary search is not a search.
 *   - `maxWidthOrHeight` only when fitWithin decided to scale. That value is the fitted
 *     image's longest side, which reproduces the box exactly while preserving the ratio.
 *     When we are not scaling we omit it, so the encoder has nothing to enlarge with.
 *
 * `alwaysKeepResolution` is deliberately left at its default. The library uses it to clamp
 * to the browser's maximum canvas size; disabling that would remove a memory safety net on
 * mobile Safari for no gain here.
 */
export function libraryOptions({ outputMime = 'image/webp', fitted = null, quality = 1, signal = null } = {}) {
  const options = {
    fileType: outputMime,
    initialQuality: clampQuality(quality, 1),
    maxIteration: 1,
    useWebWorker: false,
  };

  const longest = fitted && fitted.scaled ? Math.max(fitted.width, fitted.height) : null;
  if (Number.isFinite(longest) && longest > 0) options.maxWidthOrHeight = longest;
  if (signal) options.signal = signal;

  return options;
}

/**
 * Compresses one file: probe, decide dimensions, search for the best quality.
 *
 * Returns `{ blob, meta }` rather than a bare Blob, because the UI needs the dimensions, the
 * quality and the target outcome to render a result — and recovering those from the Blob
 * alone would mean decoding the output a second time.
 *
 * @param {File|Blob} file
 * @param {object} options `{ outputMime, targetBytes, maxWidth, maxHeight, toleranceBytes, maxPixels, signal, onProgress }`
 * @param {object} deps `{ imageCompression, probeSize }` — supplied by the worker
 */
export async function compressFile(file, options = {}, deps = {}) {
  const { imageCompression, probeSize } = deps;

  if (typeof imageCompression !== 'function') {
    throw new CompressError('INVALID_ENCODER', 'compressFile() needs an imageCompression function.');
  }
  if (typeof probeSize !== 'function') {
    throw new CompressError('INVALID_PROBE', 'compressFile() needs a probeSize function.');
  }
  if (typeof Blob !== 'function' || !(file instanceof Blob)) {
    throw new CompressError('INVALID_INPUT', 'No image file was provided.');
  }
  if (file.size === 0) {
    throw new CompressError('INVALID_INPUT', 'That file is empty.');
  }

  const {
    outputMime = 'image/webp',
    targetBytes = null,
    maxWidth = null,
    maxHeight = null,
    toleranceBytes = null,
    maxPixels = DEFAULT_MAX_PIXELS,
    userAgent = '',
    signal,
    onProgress,
  } = options;

  onProgress?.({ phase: 'probe', ratio: 0.05 });

  let source;
  try {
    source = await probeSize(file);
  } catch {
    throw new CompressError('DECODE_FAILED', 'That file could not be decoded as an image.');
  }
  if (!source || !Number.isFinite(source.width) || !Number.isFinite(source.height)) {
    throw new CompressError('DECODE_FAILED', 'That file could not be decoded as an image.');
  }

  const budget = safeMaxPixels(maxPixels, userAgent);

  /*
   * A photo bigger than the platform's canvas limit cannot be encoded at its own size — WebKit
   * fails the allocation rather than swapping. On those browsers the source is scaled down to fit
   * first, and the fact is carried back in `meta.downscaled` with the real numbers, because a
   * silent resize of someone's photo is exactly the thing this tool says it does not do. Elsewhere
   * the configured budget is policy rather than physics, and an image past it is still refused.
   */
  const capped = isWebKitAgent(userAgent)
    ? fitToPixelBudget(source.width, source.height, budget)
    : { width: source.width, height: source.height, scaled: false };
  assertPixelBudget(capped.width, capped.height, budget);

  const fitted = fitWithin({ width: capped.width, height: capped.height, maxWidth, maxHeight });
  // `fitWithin` reports scaling relative to the dimensions it was handed; a budget cap is a scale too.
  const plan = { ...fitted, scaled: fitted.scaled || capped.scaled };
  onProgress?.({ phase: 'fit', ratio: 0.15 });

  const search = await searchTargetBytes({
    targetBytes,
    toleranceBytes,
    signal,
    onAttempt: ({ attempt, quality, bytes }) => {
      onProgress?.({
        phase: 'search',
        attempt,
        quality,
        bytes,
        ratio: Math.min(0.9, 0.25 + attempt * 0.12),
      });
    },
    encode: async (quality) => {
      const encoded = await imageCompression(file, libraryOptions({ outputMime, fitted: plan, quality, signal }));
      if (!encoded || !Number.isFinite(encoded.size)) {
        throw new CompressError('ENCODE_FAILED', 'The encoder did not return a usable image.');
      }
      return { bytes: encoded.size, blob: encoded };
    },
  });

  onProgress?.({ phase: 'encode', ratio: 0.95 });

  return {
    blob: search.blob,
    meta: {
      outputMime,
      flatten: flattenForFormat(outputMime),
      sourceBytes: file.size,
      sourceWidth: source.width,
      sourceHeight: source.height,
      width: plan.width,
      height: plan.height,
      scaled: plan.scaled,
      downscaled: capped.scaled,
      budgetPixels: budget,
      bytes: search.bytes,
      quality: search.quality,
      attempts: search.attempts.length,
      status: search.status,
      targetBytes: search.targetBytes ?? null,
      overByBytes: search.overByBytes ?? 0,
      toleranceBytes: search.toleranceBytes ?? 0,
    },
  };
}
