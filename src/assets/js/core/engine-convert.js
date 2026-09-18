/**
 * Conversion planning — pure logic, no DOM.
 *
 * Two things here exist because browsers lie about formats:
 *
 *   - **Encoder support is probed, never assumed.** `canvas.convertToBlob({ type: 'image/avif' })`
 *     in Chrome does not throw; it silently returns a PNG. So the page asks the worker what it
 *     can really write, and only those formats are offered. `planConversion` refuses a requested
 *     format the browser cannot encode instead of substituting one quietly.
 *   - **Transparency needs a backdrop.** A canvas is transparent by default, and compositing a
 *     transparent canvas into JPEG gives black, not white. Anything opaque therefore gets a
 *     white fill first, which is what `needsOpaqueBackdrop` reports.
 *
 * The decode strategy is the other half: Safari reads HEIC natively, other browsers need a
 * decoder, and a file nobody can read is reported as such rather than failing deep in a canvas.
 */
import { CompressError } from './errors.js';
import { CANVAS_OUTPUT_FORMATS, defaultQualityFor, flattenForFormat, formatLabel, isHeicFile } from './formats.js';

export { flattenForFormat, formatLabel, isHeicFile } from './formats.js';

/** True when the output format cannot store alpha, so the canvas needs a white fill first. */
export function needsOpaqueBackdrop(mime) {
  return flattenForFormat(mime);
}

/**
 * The subset of `supported` that can be offered to a user, in a stable order.
 * `supported` comes from the worker's capability probe.
 */
export function availableFormats(supported, { allowed = CANVAS_OUTPUT_FORMATS } = {}) {
  const canWrite = new Set(Array.isArray(supported) ? supported : []);
  return allowed.filter((mime) => canWrite.has(mime));
}

/**
 * Resolves the format to encode with, or throws a message a person can act on.
 * No silent fallback: producing a WebP when someone asked for AVIF is a bug, not a rescue.
 */
export function chooseEncoder(requested, supported) {
  const available = availableFormats(supported);
  if (available.length === 0) {
    throw new CompressError('UNSUPPORTED', 'This browser cannot re-encode images at all, so there is nothing to convert them to.');
  }
  if (!requested) return available[0];
  if (!available.includes(requested)) {
    const wanted = formatLabel(requested);
    const canDo = available.map(formatLabel).join(', ');
    throw new CompressError(
      'UNSUPPORTED_FORMAT',
      `This browser cannot write ${wanted}. It can write ${canDo}${available.includes('image/webp') ? ', and that keeps transparency' : ''}.`,
    );
  }
  return requested;
}

/**
 * How a dropped file will be decoded.
 *   native    the browser's own decoder handles it (createImageBitmap)
 *   decoder   a wasm decoder has to be fetched and run on this device
 *   blocked   nothing here can read it
 */
export function planDecode({ file, nativeHeic = false } = {}) {
  if (!file) throw new CompressError('INVALID_INPUT', 'No image file was provided.');
  if (file.size === 0) throw new CompressError('INVALID_INPUT', 'That file is empty.');
  if (isHeicFile(file)) {
    return nativeHeic
      ? { strategy: 'native', needsDecoder: false, note: null }
      : {
          strategy: 'decoder',
          needsDecoder: true,
          note: 'HEIC needs a decoder in this browser — it runs on your device, like everything else here.',
        };
  }
  return { strategy: 'native', needsDecoder: false, note: null };
}

/** The options a canvas encoder call needs. PNG is lossless, so it takes no quality. */
export function encodeOptions({ mime, quality = null } = {}) {
  const resolved = quality ?? defaultQualityFor(mime);
  return resolved === undefined ? { type: mime } : { type: mime, quality: resolved };
}

/**
 * One call that decides everything about a conversion job: the format, how to decode into it,
 * and whether the canvas needs a backdrop. Throws early, with a reason, rather than producing a
 * file in the wrong format.
 */
export function planConversion({ file, requested, supported, nativeHeic = false } = {}) {
  const decode = planDecode({ file, nativeHeic });
  const mime = chooseEncoder(requested, supported);
  return {
    mime,
    decode: decode.strategy,
    needsDecoder: decode.needsDecoder,
    note: decode.note,
    needsBackdrop: needsOpaqueBackdrop(mime),
    quality: defaultQualityFor(mime) ?? null,
  };
}
