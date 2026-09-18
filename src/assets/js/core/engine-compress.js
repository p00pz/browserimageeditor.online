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

export function assertPixelBudget(width, height, maxPixels = DEFAULT_MAX_PIXELS) {
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

  assertPixelBudget(source.width, source.height, maxPixels);

  const fitted = fitWithin({ width: source.width, height: source.height, maxWidth, maxHeight });
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
      const encoded = await imageCompression(file, libraryOptions({ outputMime, fitted, quality, signal }));
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
      width: fitted.width,
      height: fitted.height,
      scaled: fitted.scaled,
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
