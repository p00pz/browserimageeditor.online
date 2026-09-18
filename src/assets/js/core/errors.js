/**
 * The one error type that crosses module boundaries inside the engine.
 *
 * It lives in its own module because both engine-compress.js and target-size.js need it:
 * if target-size.js imported it from engine-compress.js, and engine-compress.js imports the
 * search from target-size.js, the two would form an import cycle. engine-compress.js
 * re-exports this class, so `import { CompressError } from '../core/engine-compress.js'`
 * keeps working.
 */
export class CompressError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CompressError';
    this.code = code;
  }
}
