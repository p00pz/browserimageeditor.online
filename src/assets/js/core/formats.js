/**
 * Format facts in one place: labels, file extensions, and the two traits a tool has to know
 * about before it encodes (can this format keep transparency, and does the browser's canvas
 * know how to write it at all).
 *
 * Phase 3 pulled these out of engine-compress.js and file-io.js, which each had their own copy
 * of the label and extension maps. Both files re-export what they used to define, so no import
 * anywhere had to change. This module deliberately imports nothing: file-io.js pulls in fflate,
 * and an engine that imported file-io would drag a zip library into the unit tests.
 */

export const MIME_LABELS = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
  'image/gif': 'GIF',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',
  'application/pdf': 'PDF',
};

export const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

/** Formats that cannot store an alpha channel, so transparency needs a backing colour. */
export const OPAQUE_FORMATS = new Set(['image/jpeg']);

/**
 * The formats a browser might be able to *encode* with canvas.convertToBlob. Whether any given
 * browser can is answered by probing, never by this list: Chrome pretends to accept AVIF and
 * silently hands back a PNG, which is why output formats are verified at runtime.
 */
export const CANVAS_OUTPUT_FORMATS = ['image/webp', 'image/png', 'image/jpeg'];

/** Formats that only a decoder can read: canvas cannot decode these by itself. */
export const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

const HEIC_EXTENSIONS = new Set(['heic', 'heif']);

export function formatLabel(mime) {
  return MIME_LABELS[mime] ?? String(mime).replace('image/', '').toUpperCase();
}

export function extensionFor(mime, fallback = 'img') {
  return EXTENSIONS[mime] ?? fallback;
}

/** True when the output format drops transparency and needs a white backing. */
export function flattenForFormat(mime) {
  return OPAQUE_FORMATS.has(mime);
}

export function isHeicType(mime) {
  return HEIC_TYPES.has(String(mime ?? '').toLowerCase());
}

/**
 * HEIC detection that survives the common case: browsers hand over an iPhone photo with an
 * empty `file.type`, sometimes with a .HEIC extension in any case, so both are checked.
 */
export function isHeicFile(file) {
  if (!file) return false;
  if (isHeicType(file.type)) return true;
  const extension = String(file.name ?? '').split('.').pop()?.toLowerCase() ?? '';
  return HEIC_EXTENSIONS.has(extension);
}

/**
 * Default encoder quality per format. PNG is lossless, so it takes none.
 * These are the values the tools pass to convertToBlob.
 */
export function defaultQualityFor(mime) {
  if (mime === 'image/jpeg') return 0.9;
  if (mime === 'image/webp') return 0.92;
  return undefined;
}
