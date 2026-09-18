/**
 * Conversion planning and the shared format facts. Run with `npm test`.
 *
 * The important behaviour here is the refusal: a browser that cannot write AVIF must never quietly
 * produce a WebP, so these tests pin the error rather than a fallback.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  availableFormats,
  chooseEncoder,
  encodeOptions,
  needsOpaqueBackdrop,
  planConversion,
  planDecode,
} from '../src/assets/js/core/engine-convert.js';
import {
  CANVAS_OUTPUT_FORMATS,
  defaultQualityFor,
  extensionFor,
  flattenForFormat,
  formatLabel,
  isHeicFile,
  isHeicType,
} from '../src/assets/js/core/formats.js';
import { CompressError } from '../src/assets/js/core/errors.js';

function heicFile(name = 'IMG_1234.HEIC') {
  // Browsers commonly hand HEIC files over with an empty type, which is why the extension matters.
  // The type goes through the constructor: Blob.type is a read-only accessor, so Object.assign
  // would throw rather than overwrite it.
  return Object.assign(new Blob([new Uint8Array(16)]), { name });
}

test('only formats the browser confirmed are offered', () => {
  assert.deepEqual(availableFormats(['image/webp', 'image/jpeg']), ['image/webp', 'image/jpeg']);
  assert.deepEqual(availableFormats(['image/avif']), [], 'AVIF is not a canvas output format');
  assert.deepEqual(availableFormats(null), []);
  assert.deepEqual(CANVAS_OUTPUT_FORMATS, ['image/webp', 'image/png', 'image/jpeg']);
});

test('a requested format the browser cannot write is refused, not substituted', () => {
  assert.throws(
    () => chooseEncoder('image/avif', ['image/webp', 'image/png']),
    (error) =>
      error instanceof CompressError &&
      error.code === 'UNSUPPORTED_FORMAT' &&
      /AVIF/.test(error.message) &&
      /WebP, PNG/.test(error.message),
  );
});

test('a browser that can encode nothing at all says so plainly', () => {
  assert.throws(
    () => chooseEncoder('image/webp', []),
    (error) => error.code === 'UNSUPPORTED' && /cannot re-encode images at all/.test(error.message),
  );
});

test('a blank request falls back to the preference order, and a supported request is honoured', () => {
  // The first choice is WebP when the browser supports it, not whichever format the probe
  // happened to report first.
  assert.equal(chooseEncoder('', ['image/jpeg', 'image/webp']), 'image/webp');
  assert.equal(chooseEncoder('', ['image/jpeg']), 'image/jpeg');
  assert.equal(chooseEncoder('image/jpeg', ['image/jpeg', 'image/webp']), 'image/jpeg');
});

test('HEIC decodes natively where the browser can, and by decoder where it cannot', () => {
  assert.deepEqual(planDecode({ file: heicFile(), nativeHeic: true }), {
    strategy: 'native',
    needsDecoder: false,
    note: null,
  });
  const viaDecoder = planDecode({ file: heicFile(), nativeHeic: false });
  assert.equal(viaDecoder.strategy, 'decoder');
  assert.equal(viaDecoder.needsDecoder, true);
  assert.match(viaDecoder.note, /on your device/);
});

test('a JPEG is always a native decode', () => {
  const jpeg = Object.assign(new Blob([new Uint8Array(8)], { type: 'image/jpeg' }), { name: 'photo.jpg' });
  assert.equal(planDecode({ file: jpeg }).strategy, 'native');
});

test('an empty or missing file is refused before any decoding', () => {
  assert.throws(() => planDecode({}), (error) => error.code === 'INVALID_INPUT');
  assert.throws(
    () => planDecode({ file: Object.assign(new Blob([]), { name: 'nothing.png' }) }),
    (error) => error.code === 'INVALID_INPUT' && /empty/.test(error.message),
  );
});

test('HEIC is detected by type or by extension, case insensitively', () => {
  assert.equal(isHeicType('image/heic'), true);
  assert.equal(isHeicType('image/heif-sequence'), true);
  assert.equal(isHeicType('image/jpeg'), false);
  assert.equal(isHeicFile(heicFile('photo.HEIF')), true);
  assert.equal(isHeicFile(heicFile('photo.heic')), true);
  assert.equal(
    isHeicFile(Object.assign(new Blob([new Uint8Array(4)], { type: 'image/heif' }), { name: 'photo.heif' })),
    true,
  );
  assert.equal(isHeicFile(Object.assign(new Blob([new Uint8Array(4)], { type: 'image/jpeg' }), { name: 'photo.jpg' })), false);
  assert.equal(isHeicFile(null), false);
});

test('planConversion decides the format, the decode route and the backdrop in one step', () => {
  const plan = planConversion({
    file: Object.assign(new Blob([new Uint8Array(8)], { type: 'image/png' }), { name: 'photo.png' }),
    requested: 'image/jpeg',
    supported: ['image/webp', 'image/jpeg'],
  });
  assert.deepEqual(plan, {
    mime: 'image/jpeg',
    decode: 'native',
    needsDecoder: false,
    note: null,
    needsBackdrop: true,
    quality: 0.9,
  });

  const webp = planConversion({
    file: heicFile(),
    requested: 'image/webp',
    supported: ['image/webp'],
    nativeHeic: false,
  });
  assert.equal(webp.decode, 'decoder');
  assert.equal(webp.needsBackdrop, false, 'WebP keeps transparency, so nothing is flattened');
});

test('encoder options drop quality for a lossless format', () => {
  assert.deepEqual(encodeOptions({ mime: 'image/png' }), { type: 'image/png' });
  assert.deepEqual(encodeOptions({ mime: 'image/jpeg' }), { type: 'image/jpeg', quality: 0.9 });
  assert.deepEqual(encodeOptions({ mime: 'image/webp', quality: 0.5 }), { type: 'image/webp', quality: 0.5 });
  assert.equal(defaultQualityFor('image/png'), undefined);
});

test('the transparency rule is about the output format, not the input', () => {
  assert.equal(needsOpaqueBackdrop('image/jpeg'), true);
  assert.equal(needsOpaqueBackdrop('image/png'), false);
  assert.equal(needsOpaqueBackdrop('image/webp'), false);
  assert.equal(flattenForFormat('image/jpeg'), true);
});

test('labels and extensions come from one table', () => {
  assert.equal(formatLabel('image/webp'), 'WebP');
  assert.equal(formatLabel('image/heic'), 'HEIC');
  assert.equal(formatLabel('image/tiff'), 'TIFF');
  assert.equal(extensionFor('image/jpeg'), 'jpg');
  assert.equal(extensionFor('application/pdf'), 'pdf');
  assert.equal(extensionFor('image/tiff'), 'img');
  assert.equal(extensionFor('image/tiff', 'tif'), 'tif');
});
