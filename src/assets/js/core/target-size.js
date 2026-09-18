/**
 * Target-size search — pure logic, no DOM, no browser APIs, no dependencies.
 *
 * Given an encoder that can produce the same image at a chosen quality, this finds the
 * highest quality whose output still fits a byte budget, and classifies the outcome so the
 * UI can tell "we hit it" from "this is as small as this image gets".
 *
 * The promise this module keeps: `status: 'hit'` **never** exceeds `targetBytes`. When the
 * target is out of reach the caller gets the smallest file we could produce, plus how far
 * over it is, and decides what to say — nothing here ships an oversized file silently.
 *
 * There is deliberately no implicit fallback: `encode` is supplied by the caller, which is
 * what lets the worker inject the real encoder and lets tests/ run in plain Node.
 */
import { CompressError } from './errors.js';

export const QUALITY_SEARCH_DEFAULTS = Object.freeze({
  minQuality: 0.3,
  maxQuality: 0.95,
  maxIterations: 6,
  minStep: 0.005,
});

/**
 * How far over the target a result may be and still be reported as `near` rather than
 * `unreachable`. Reporting only — it never allows a file over the target to be called a hit.
 */
export const DEFAULT_TOLERANCE_RATIO = 0.02;

/** Smallest tolerance worth reporting, so a 10 KB target does not get a 200-byte grace. */
const MIN_TOLERANCE_BYTES = 256;

function clampQuality(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** Tolerance in bytes: an explicit value wins, otherwise 2% of the target, floored at 256 B. */
export function toleranceFor(targetBytes, toleranceBytes = null) {
  if (Number.isFinite(toleranceBytes) && toleranceBytes >= 0) return Math.round(toleranceBytes);
  if (!Number.isFinite(targetBytes) || targetBytes <= 0) return 0;
  return Math.max(MIN_TOLERANCE_BYTES, Math.round(targetBytes * DEFAULT_TOLERANCE_RATIO));
}

/**
 * Finds the highest quality whose output fits `targetBytes`.
 *
 * Strategy, chosen to spend as few encodes as possible:
 *   1. no target: one encode at `maxQuality` and we are done;
 *   2. try `maxQuality` — if it already fits, that is the answer (1 encode);
 *   3. try `minQuality` — if even that is too big, the target is out of reach. We still
 *      return the smallest file we made, marked `near` (within tolerance) or `unreachable`;
 *   4. otherwise bisect between the two and keep the largest quality that fits.
 *
 * @param {object} options
 * @param {(quality: number) => Promise<{ bytes: number, blob: Blob }>} options.encode
 * @returns {Promise<{ blob, quality, bytes, attempts, status, targetBytes, overByBytes, toleranceBytes }>}
 */
export async function searchTargetBytes({
  targetBytes = null,
  toleranceBytes = null,
  minQuality = QUALITY_SEARCH_DEFAULTS.minQuality,
  maxQuality = QUALITY_SEARCH_DEFAULTS.maxQuality,
  maxIterations = QUALITY_SEARCH_DEFAULTS.maxIterations,
  minStep = QUALITY_SEARCH_DEFAULTS.minStep,
  encode,
  onAttempt,
  signal,
} = {}) {
  if (typeof encode !== 'function') {
    throw new CompressError('INVALID_ENCODE', 'searchTargetBytes() requires an encode(quality) function.');
  }

  const minimum = clampQuality(minQuality, QUALITY_SEARCH_DEFAULTS.minQuality);
  const maximum = Math.max(minimum, clampQuality(maxQuality, QUALITY_SEARCH_DEFAULTS.maxQuality));
  const round = (quality) => Math.round(quality * 1000) / 1000;
  const attempts = [];

  async function runEncode(quality) {
    if (signal?.aborted) throw new CompressError('ABORTED', 'Compression was cancelled.');
    const result = await encode(quality);
    if (!result || !Number.isFinite(result.bytes)) {
      throw new CompressError(
        'INVALID_ENCODE_RESULT',
        'encode(quality) must resolve to an object with a numeric "bytes".',
      );
    }
    attempts.push({ quality, bytes: result.bytes });
    onAttempt?.({ attempt: attempts.length, quality, bytes: result.bytes });
    return result;
  }

  const wanted = Number.isFinite(targetBytes) && targetBytes > 0;
  const tolerance = wanted ? toleranceFor(targetBytes, toleranceBytes) : 0;

  if (!wanted) {
    const result = await runEncode(maximum);
    return {
      blob: result.blob ?? null,
      quality: maximum,
      bytes: result.bytes,
      attempts,
      status: 'hit',
      targetBytes: null,
      overByBytes: 0,
      toleranceBytes: 0,
    };
  }

  const top = await runEncode(maximum);
  if (top.bytes <= targetBytes) {
    return {
      blob: top.blob ?? null,
      quality: maximum,
      bytes: top.bytes,
      attempts,
      status: 'hit',
      targetBytes,
      overByBytes: 0,
      toleranceBytes: tolerance,
    };
  }

  const floor = await runEncode(minimum);
  if (floor.bytes > targetBytes) {
    const overByBytes = floor.bytes - targetBytes;
    return {
      blob: floor.blob ?? null,
      quality: minimum,
      bytes: floor.bytes,
      attempts,
      status: overByBytes <= tolerance ? 'near' : 'unreachable',
      targetBytes,
      overByBytes,
      toleranceBytes: tolerance,
    };
  }

  let best = { blob: floor.blob ?? null, quality: minimum, bytes: floor.bytes };
  let low = minimum;
  let high = maximum;
  const rounds = Math.max(1, Math.min(12, Math.round(maxIterations)));

  for (let roundIndex = 0; roundIndex < rounds && high - low > minStep; roundIndex += 1) {
    const quality = round(low + (high - low) / 2);
    if (quality === low || quality === high) break;
    const result = await runEncode(quality);
    if (result.bytes <= targetBytes) {
      best = { blob: result.blob ?? null, quality, bytes: result.bytes };
      low = quality;
    } else {
      high = quality;
    }
  }

  return {
    blob: best.blob,
    quality: best.quality,
    bytes: best.bytes,
    attempts,
    status: 'hit',
    targetBytes,
    overByBytes: 0,
    toleranceBytes: tolerance,
  };
}
