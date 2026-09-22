/**
 * Dropzone component — reusable, and deliberately dumb.
 *
 * It owns three ways to hand you files (click-to-browse, drag and drop, paste from the
 * clipboard) and it hands the File objects back. It never reads, decodes, compresses,
 * resizes, uploads or stores anything, and it validates nothing unless the caller opts in
 * by passing `accept` or `maxBytes`. With no constraints configured it forwards whatever
 * the browser gives it, empty files included — deciding what is acceptable is the caller's
 * job, not the component's.
 *
 * The markup works before JavaScript loads: the dropzone is a <label> wrapped around a real
 * file input, so click and keyboard activation are native. Drag, paste and validation are
 * layered on top, and all four paths funnel through one handleFiles() call.
 *
 * Callbacks:
 *   onFiles(files)          every accepted File, in the order the browser supplied them
 *   onReject(reason, file)  only when accept/maxBytes/multiple are set and a file fails them
 *
 * `reason` is { code, message } where code is one of:
 *   EMPTY_FILE | TOO_LARGE | UNSUPPORTED_TYPE | TOO_MANY_FILES
 *
 * Visual states toggled on the root element:
 *   is-dragging  a drag is over the dropzone
 *   is-disabled  disable() was called
 *   is-invalid   the last batch contained a rejected file (transient)
 *   has-file     at least one file was accepted (cleared by reset())
 */
import { receiveHandoff } from './tool-handoff.js';
import { formatBytes } from './format.js';
import { t } from './strings.js';
import { HEIC_TYPES } from '../core/formats.js';

// Re-exported so callers that already imported it from this component keep working.
export { formatBytes };

const EXTENSION_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
};

// A HEIC file often arrives with an empty `file.type` — iPhones hand them over that way — and the
// convert tool advertises HEIC, so the extension fallback has to resolve it. The mime types come
// from core/formats.js so there is one HEIC table for the whole site; the sequence variants share
// an extension with their still variants and are not separate entries.
for (const mime of HEIC_TYPES) {
  if (mime.includes('-sequence')) continue;
  EXTENSION_TYPES[mime.replace('image/', '')] = mime;
}

/** How long the is-invalid state stays on screen after a rejection. */
const INVALID_STATE_MS = 2400;

function resolveType(file) {
  if (file.type) return file.type;
  const extension = file.name?.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[extension] ?? '';
}

function typeLabel(mime) {
  return String(mime).replace('image/', '').toUpperCase();
}

export function createDropzone(root, { accept = null, maxBytes = null, multiple = false, onFiles, onReject } = {}) {
  if (!root) throw new Error('createDropzone: a root element is required.');
  const input = root.querySelector('[data-dropzone-input]');
  if (!input) throw new Error('createDropzone: the root element must contain [data-dropzone-input].');

  const acceptedTypes = accept === null ? [] : Array.isArray(accept) ? accept : [accept];
  const sizeLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : null;
  const validate = acceptedTypes.length > 0 || sizeLimit !== null;

  input.multiple = Boolean(multiple);
  if (acceptedTypes.length > 0) input.accept = acceptedTypes.join(',');

  let disabled = false;
  let invalidTimer = null;

  function flagInvalid() {
    root.classList.add('is-invalid');
    if (invalidTimer) clearTimeout(invalidTimer);
    invalidTimer = setTimeout(() => {
      root.classList.remove('is-invalid');
      invalidTimer = null;
    }, INVALID_STATE_MS);
  }

  /** Returns a reason object, or null when the file is acceptable. */
  function rejectionFor(file) {
    if (file.size === 0) {
      return { code: 'EMPTY_FILE', message: t('js.dropzone.empty', { name: file.name }) };
    }
    if (sizeLimit !== null && file.size > sizeLimit) {
      return {
        code: 'TOO_LARGE',
        message: t('js.dropzone.tooLarge', {
          name: file.name,
          size: formatBytes(file.size),
          limit: formatBytes(sizeLimit),
        }),
      };
    }
    if (acceptedTypes.length > 0) {
      const type = resolveType(file);
      if (!type || !acceptedTypes.includes(type)) {
        return {
          code: 'UNSUPPORTED_TYPE',
          message: t('js.dropzone.unsupportedType', {
            name: file.name,
            accepted: acceptedTypes.map(typeLabel).join(', '),
          }),
        };
      }
    }
    return null;
  }

  function handleFiles(fileList) {
    if (disabled) return;
    let files = Array.from(fileList ?? []).filter(Boolean);
    if (files.length === 0) return;

    if (!multiple && files.length > 1) {
      onReject?.({
        code: 'TOO_MANY_FILES',
        message: t('js.dropzone.tooMany', { count: files.length, name: files[0].name }),
      });
      files = files.slice(0, 1);
    }

    const accepted = [];
    for (const file of files) {
      const reason = validate ? rejectionFor(file) : null;
      if (reason) {
        flagInvalid();
        onReject?.(reason, file);
      } else {
        accepted.push(file);
      }
    }

    if (accepted.length > 0) {
      root.classList.add('has-file');
      onFiles?.(accepted);
    }
  }

  function onDragOver(event) {
    event.preventDefault();
    if (!disabled) root.classList.add('is-dragging');
  }

  function onDragLeave(event) {
    if (event.relatedTarget && root.contains(event.relatedTarget)) return;
    root.classList.remove('is-dragging');
  }

  function onDrop(event) {
    event.preventDefault();
    root.classList.remove('is-dragging');
    handleFiles(event.dataTransfer?.files);
  }

  function onInputChange() {
    handleFiles(input.files);
    // Reset the input so choosing the same file twice fires change again.
    input.value = '';
  }

  function onPaste(event) {
    if (disabled || event.defaultPrevented || event.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
    const files = event.clipboardData?.files;
    if (files && files.length > 0) {
      event.preventDefault();
      handleFiles(files);
    }
  }

  let pendingFile = null;
  const stopHandoff = receiveHandoff((file) => {
    if (disabled) pendingFile = file;
    else handleFiles([file]);
  });

  root.addEventListener('dragenter', onDragOver);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDrop);
  input.addEventListener('change', onInputChange);
  document.addEventListener('paste', onPaste);

  return {
    destroy() {
      stopHandoff();
      pendingFile = null;
      if (invalidTimer) clearTimeout(invalidTimer);
      invalidTimer = null;
      root.removeEventListener('dragenter', onDragOver);
      root.removeEventListener('dragover', onDragOver);
      root.removeEventListener('dragleave', onDragLeave);
      root.removeEventListener('drop', onDrop);
      input.removeEventListener('change', onInputChange);
      document.removeEventListener('paste', onPaste);
    },
    disable() {
      disabled = true;
      input.disabled = true;
      root.classList.add('is-disabled');
    },
    enable() {
      disabled = false;
      input.disabled = false;
      root.classList.remove('is-disabled');
      if (pendingFile) {
        const file = pendingFile;
        pendingFile = null;
        queueMicrotask(() => handleFiles([file]));
      }
    },
    reset() {
      input.value = '';
      root.classList.remove('has-file', 'is-invalid');
    },
    open() {
      if (!disabled) input.click();
    },
  };
}
