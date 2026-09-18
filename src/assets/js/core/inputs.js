/**
 * Input parsing shared by every tool.
 *
 * These two parsers started life inside engine-compress.js. They moved here in Phase 3 because
 * resize, convert and the crop tool all accept typed numbers too, and a second copy of "is this
 * a positive number" is exactly the kind of duplication that drifts. engine-compress.js
 * re-exports both, so no import anywhere had to change.
 *
 * The error code stays the caller's choice: the compress page and the resize page describe a
 * bad width differently, but it is the same class of mistake, so it is the same code path.
 */
import { CompressError } from './errors.js';

function check(value, fallback, code, message) {
  if (value === null || value === undefined || value === '') return fallback;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new CompressError(code, message);
  return amount;
}

/**
 * Target size as typed by a person, in kilobytes, converted to bytes.
 * Blank means "no target", which is not an error.
 */
export function parseTargetBytes(value, { bytesPerUnit = 1024 } = {}) {
  const amount = check(
    typeof value === 'string' ? value.trim() : value,
    null,
    'INVALID_TARGET',
    'Enter a target size greater than zero, or leave it blank to keep the best quality.',
  );
  return amount === null ? null : Math.round(amount * bytesPerUnit);
}

/** Max width/height as typed by a person. Blank means "keep the original". */
export function parseDimension(value, { code = 'INVALID_DIMENSION', message } = {}) {
  const amount = check(
    typeof value === 'string' ? value.trim() : value,
    null,
    code,
    message ?? 'Max width and max height must be positive numbers, or blank to keep the original size.',
  );
  return amount === null ? null : Math.round(amount);
}
