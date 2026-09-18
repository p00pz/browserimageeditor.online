/**
 * File output — one download, or a whole batch as a ZIP.
 *
 * The naming and ZIP-building logic is pure and separated from the two functions that touch
 * the DOM, so tests/file-io.test.js can check the parts that actually go wrong (name
 * collisions, wrong extension) without a browser.
 */
import { zipSync } from 'fflate';

import { extensionFor } from './formats.js';

/** Defined in ./formats.js so an engine can use it without importing fflate. Re-exported here. */
export { extensionFor };

export const DEFAULT_ZIP_NAME = 'browserimageeditor-compressed.zip';

/**
 * ZIP entries are stored, not deflated. The inputs are already-compressed JPEG/WebP/PNG, so
 * deflating them costs real CPU time for roughly nothing back.
 */
export const ZIP_STORED_LEVEL = 0;

/** Above this, the ZIP holder gets a note that the batch is holding a lot of memory. */
export const ZIP_SIZE_WARNING_BYTES = 200 * 1024 * 1024;

/** "holiday.photo.jpg" -> "holiday.photo". A dotfile ("\.env") keeps its name. */
export function baseName(filename) {
  const name = String(filename ?? '').trim();
  const stripped = name.replace(/\.[^./\\]+$/, '').trim();
  if (stripped === '') return name || 'image';
  return stripped;
}

/** Appends "-2", "-3", ... until the name is free, keeping the extension intact. */
export function uniqueName(candidate, taken) {
  const name = String(candidate || 'image');
  const used = taken instanceof Set ? taken : new Set(taken ?? []);
  if (!used.has(name)) return name;

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const suffix = dot > 0 ? name.slice(dot) : '';
  for (let index = 2; index < 10_000; index += 1) {
    const next = `${stem}-${index}${suffix}`;
    if (!used.has(next)) return next;
  }
  return `${stem}-${Date.now()}${suffix}`;
}

/** Output filename for one compressed file, e.g. "photo-compressed.webp". */
export function zipNameFor(originalName, extension, { suffix = '-compressed' } = {}) {
  const resolved = String(extension ?? '').trim() || 'img';
  return `${baseName(originalName)}${suffix}.${resolved}`;
}

/**
 * Turns `[{ name, bytes }]` into the plain object fflate wants, renaming collisions so no
 * entry can silently overwrite another. Entries without bytes are skipped.
 */
export function buildZipEntries(results) {
  const taken = new Set();
  const entries = {};
  for (const result of results ?? []) {
    if (!result || !result.bytes || !result.name) continue;
    const name = uniqueName(result.name, taken);
    taken.add(name);
    entries[name] = result.bytes;
  }
  return entries;
}

/** Blob -> Uint8Array, because fflate works on bytes rather than Blobs. */
export async function toBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

export function totalBytes(results) {
  return (results ?? []).reduce((sum, result) => sum + (result?.bytes?.byteLength ?? 0), 0);
}

/** Builds the ZIP as bytes. Throws when there is nothing to put in it. */
export function buildZip(results) {
  const entries = buildZipEntries(results);
  if (Object.keys(entries).length === 0) {
    throw new Error('There is nothing to download yet.');
  }
  return zipSync(entries, { level: ZIP_STORED_LEVEL });
}

/**
 * Triggers a download through a temporary anchor. Object URLs are revoked on the next tick,
 * which is long enough for every browser we target to have started the download.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'download';
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Zips `[{ name, bytes }]` and downloads it. */
export function downloadZip(results, { filename = DEFAULT_ZIP_NAME } = {}) {
  const bytes = buildZip(results);
  downloadBlob(new Blob([bytes], { type: 'application/zip' }), filename);
  return bytes.byteLength;
}
