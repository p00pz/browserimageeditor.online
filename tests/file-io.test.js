/**
 * File-output tests. The naming logic and the ZIP build are pure, so they run in plain Node;
 * only downloadBlob/downloadZip touch the DOM.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { unzipSync } from 'fflate';

import {
  DEFAULT_ZIP_NAME,
  ZIP_STORED_LEVEL,
  baseName,
  buildZip,
  buildZipEntries,
  extensionFor,
  uniqueName,
  zipNameFor,
} from '../src/assets/js/core/file-io.js';

test('extensionFor maps the formats the tools produce', () => {
  assert.equal(extensionFor('image/jpeg'), 'jpg');
  assert.equal(extensionFor('image/webp'), 'webp');
  assert.equal(extensionFor('image/png'), 'png');
  assert.equal(extensionFor('image/tiff'), 'img');
  assert.equal(extensionFor('image/tiff', 'tif'), 'tif');
});

test('baseName drops only the final extension', () => {
  assert.equal(baseName('holiday.photo.jpg'), 'holiday.photo');
  assert.equal(baseName('no-extension'), 'no-extension');
  assert.equal(baseName(''), 'image');
  assert.equal(baseName(null), 'image');
  assert.equal(baseName('.gitignore'), '.gitignore');
});

test('zipNameFor uses the extension the tool actually produced', () => {
  assert.equal(zipNameFor('holiday.jpg', 'webp'), 'holiday-compressed.webp');
  assert.equal(zipNameFor('holiday.jpg', 'webp', { suffix: '' }), 'holiday.webp');
  assert.equal(zipNameFor('holiday.jpg', ''), 'holiday-compressed.img');
});

test('uniqueName numbers collisions without losing the extension', () => {
  assert.equal(uniqueName('photo.jpg', []), 'photo.jpg');
  assert.equal(uniqueName('photo.jpg', ['photo.jpg']), 'photo-2.jpg');
  assert.equal(uniqueName('photo.jpg', ['photo.jpg', 'photo-2.jpg']), 'photo-3.jpg');
  assert.equal(uniqueName('archive.tar.gz', ['archive.tar.gz']), 'archive.tar-2.gz');
  assert.equal(uniqueName('no-extension', ['no-extension']), 'no-extension-2');
  assert.equal(uniqueName('photo.jpg', new Set(['photo.jpg'])), 'photo-2.jpg');
});

test('buildZipEntries skips empty results and renames duplicate names', () => {
  const entries = buildZipEntries([
    { name: 'photo.webp', bytes: new Uint8Array([1, 2, 3]) },
    { name: 'photo.webp', bytes: new Uint8Array([4, 5]) },
    { name: 'nothing.webp', bytes: null },
    null,
    { name: '', bytes: new Uint8Array([9]) },
  ]);

  assert.deepEqual(Object.keys(entries), ['photo.webp', 'photo-2.webp']);
  assert.deepEqual([...entries['photo.webp']], [1, 2, 3]);
  assert.deepEqual([...entries['photo-2.webp']], [4, 5]);
});

test('buildZip produces a ZIP that unpacks back to the same bytes', () => {
  const results = [
    { name: 'one.webp', bytes: new Uint8Array([1, 2, 3, 4]) },
    { name: 'two.webp', bytes: new Uint8Array([5, 6, 7]) },
  ];
  const zip = buildZip(results);
  const unpacked = unzipSync(zip);

  assert.deepEqual(Object.keys(unpacked).sort(), ['one.webp', 'two.webp']);
  assert.deepEqual([...unpacked['one.webp']], [1, 2, 3, 4]);
  assert.deepEqual([...unpacked['two.webp']], [5, 6, 7]);
});

test('buildZip refuses to produce an empty archive', () => {
  assert.throws(() => buildZip([]), /nothing to download/);
  assert.throws(() => buildZip([{ name: 'x.webp', bytes: null }]), /nothing to download/);
});

test('the ZIP name and compression level are the ones the tool advertises', () => {
  assert.equal(DEFAULT_ZIP_NAME, 'browserimageeditor-compressed.zip');
  // Stored, not deflated: the entries are already-compressed images.
  assert.equal(ZIP_STORED_LEVEL, 0);
});
