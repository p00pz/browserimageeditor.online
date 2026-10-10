// Files and PDF bytes remain on the device. Only one source is parsed at a time.
export const PDF_MERGE_LIMITS = Object.freeze({ fileBytes: 20 * 1024 * 1024, totalBytes: 60 * 1024 * 1024, files: 30, pages: 500 });

export class PdfMergeError extends Error {
  constructor(code, fileName = '') {
    super(code);
    this.code = code;
    this.fileName = fileName;
  }
}

function fail(code, file) { throw new PdfMergeError(code, file?.name); }

export async function loadMergeSource(file) {
  if (!file?.size) fail('EMPTY', file);
  if (file.size > PDF_MERGE_LIMITS.fileBytes) fail('FILE_LIMIT', file);
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name ?? '')) fail('TYPE', file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Require a real header, including PDFs with a short leading prefix.
  if (!new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-')) fail('INVALID', file);
  const { PDFDocument, PDFName, PDFDict } = await import('pdf-lib');
  try {
    // Inspect the encryption flag, then reject before reading or copying pages. This does not
    // decrypt files; pdf-lib's ES5 Error subclasses do not reliably support instanceof.
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: true });
    if (doc.isEncrypted) fail('ENCRYPTED', file);
    const pages = doc.getPageCount();
    if (!pages) fail('NO_PAGES', file);
    if (pages > PDF_MERGE_LIMITS.pages) fail('PAGE_LIMIT', file);
    // getForm() removes XFA automatically; check the original dictionary first.
    if (doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.has(PDFName.of('XFA'))) fail('FORM', file);
    return doc;
  } catch (error) {
    if (error instanceof PdfMergeError) throw error;
    fail('INVALID', file);
  }
}

export async function inspectMergeFiles(files, existing = {}, onProgress = () => {}) {
  let count = existing.count ?? 0;
  let bytes = existing.bytes ?? 0;
  let pages = existing.pages ?? 0;
  const results = [];
  for (const [index, file] of files.entries()) {
    try {
      if (count >= PDF_MERGE_LIMITS.files) fail('COUNT_LIMIT', file);
      if (bytes + file.size > PDF_MERGE_LIMITS.totalBytes) fail('TOTAL_LIMIT', file);
      const doc = await loadMergeSource(file);
      const pageCount = doc.getPageCount();
      if (pages + pageCount > PDF_MERGE_LIMITS.pages) fail('PAGE_LIMIT', file);
      results.push({ index, pages: pageCount });
      count++;
      bytes += file.size;
      pages += pageCount;
    } catch (error) {
      results.push({ index, error: error.code ?? 'INVALID' });
    }
    onProgress((index + 1) / files.length);
  }
  return results;
}

export async function mergePdfFiles(files, onProgress = () => {}) {
  if (files.length < 2) fail('MIN_FILES');
  if (files.length > PDF_MERGE_LIMITS.files) fail('COUNT_LIMIT');
  if (files.reduce((sum, file) => sum + file.size, 0) > PDF_MERGE_LIMITS.totalBytes) fail('TOTAL_LIMIT');
  const { PDFDocument } = await import('pdf-lib');
  const output = await PDFDocument.create();
  for (const [index, file] of files.entries()) {
    const source = await loadMergeSource(file);
    if (output.getPageCount() + source.getPageCount() > PDF_MERGE_LIMITS.pages) fail('PAGE_LIMIT', file);
    // Preserve the visible values of standard form fields without orphaned interactive widgets.
    try { source.getForm().flatten(); } catch { fail('FORM', file); }
    try {
      for (const page of await output.copyPages(source, source.getPageIndices())) output.addPage(page);
    } catch { fail('INVALID', file); }
    onProgress((index + 1) / (files.length + 1));
  }
  const bytes = await output.save();
  onProgress(1);
  return { blob: new Blob([bytes], { type: 'application/pdf' }), pages: output.getPageCount() };
}
