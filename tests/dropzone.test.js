/**
 * The dropzone's extension fallback. Run with `npm test`.
 *
 * Browsers hand a HEIC photo over with an empty `file.type` often enough that the convert tool —
 * which advertises HEIC — has to accept one by extension. The fallback map is what answers that,
 * so the test drives a dropzone with a document shim and asks it to validate exactly that file.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDropzone } from '../src/assets/js/ui/dropzone.js';
import { HEIC_TYPES } from '../src/assets/js/core/formats.js';

/** The smallest document an element needs for createDropzone to wire itself up. */
function makeEnvironment() {
  const inputListeners = new Map();
  const documentListeners = new Map();
  const input = {
    multiple: false,
    value: '',
    disabled: false,
    accept: '',
    addEventListener: (event, handler) => inputListeners.set(event, handler),
    removeEventListener: () => {},
    click: () => {},
  };
  const root = {
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => false,
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    querySelector: (selector) => (selector === '[data-dropzone-input]' ? input : null),
  };
  globalThis.document = {
    // No `#ui-strings` block exists outside a page, which the strings module treats as an empty
    // catalogue rather than an error — the same as a page that has not been built.
    getElementById: () => null,
    addEventListener: (event, handler) => documentListeners.set(event, handler),
    removeEventListener: () => {},
  };
  return { root, input, inputListeners, documentListeners };
}

/** A HEIC file as a browser actually delivers one: an empty type, the extension doing the work. */
function heicFile(name = 'IMG_1234.HEIC') {
  return Object.assign(new Blob([new Uint8Array(16)]), { name });
}

test('a HEIC file with an empty type is accepted by the extension fallback', () => {
  const { root, input, inputListeners } = makeEnvironment();
  const accepted = [];
  const rejected = [];

  createDropzone(root, {
    accept: ['image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/webp'],
    onFiles: (files) => accepted.push(...files),
    onReject: (reason) => rejected.push(reason),
  });

  // What a `change` event would hand the handler: the input's own file list. The handler resets the
  // input afterwards so the same file can be chosen twice, which is the documented behaviour.
  input.files = [heicFile()];
  inputListeners.get('change')?.({ target: input });

  assert.equal(rejected.length, 0, 'a HEIC the tool advertises must not be rejected');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].name, 'IMG_1234.HEIC');
});

test('a type the accept list never mentioned is still rejected', () => {
  const { root, input, inputListeners } = makeEnvironment();
  const accepted = [];
  const rejected = [];

  createDropzone(root, {
    accept: ['image/heic', 'image/jpeg'],
    onFiles: (files) => accepted.push(...files),
    onReject: (reason) => rejected.push(reason),
  });

  const tiff = Object.assign(new Blob([new Uint8Array(8)]), { name: 'scan.tiff' });
  input.files = [tiff];
  inputListeners.get('change')?.({ target: input });

  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].code, 'UNSUPPORTED_TYPE');
});

test('HEIC stays recognisable as a HEIC, by type or by extension', () => {
  // The fallback resolves extensions to the non-sequence mimes, which are the ones an accept list
  // names; the sequence variants share an extension with the still variants either way.
  const resolved = new Set();
  for (const mime of HEIC_TYPES) {
    if (mime.includes('-sequence')) continue;
    resolved.add(mime.replace('image/', ''));
  }
  assert.deepEqual([...resolved].sort(), ['heic', 'heif']);
});


test('paste leaves editable fields and disabled tools alone', () => {
  const { root, documentListeners } = makeEnvironment();
  const files = [];
  const dropzone = createDropzone(root, { onFiles: (items) => files.push(...items) });
  let prevented = false;
  const event = { clipboardData: { files: [heicFile()] }, preventDefault: () => { prevented = true; }, target: { closest: () => ({}) } };
  documentListeners.get('paste')(event);
  assert.equal(prevented, false);
  assert.equal(files.length, 0);
  event.target.closest = () => null;
  dropzone.disable();
  documentListeners.get('paste')(event);
  assert.equal(prevented, false);
  dropzone.enable();
  documentListeners.get('paste')(event);
  assert.equal(prevented, true);
  assert.equal(files.length, 1);
  dropzone.destroy();
});
