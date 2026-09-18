/**
 * PDF worker — one RPC per image, then one to assemble the document.
 *
 * Contract (same shape as compress.worker.js, split in two because a PDF is a single output built
 * from many inputs):
 *   capabilities()                                    -> { supported, missing[] }
 *   encodePage({ jobId, file, options }, onProgress)   -> { bytes, mime, width, height, name }
 *   assemble({ pages, options })                       -> { blob, meta }
 *   cancel(jobId)                                      -> void
 *
 * `onProgress` is a separate top-level argument: comlink only wires top-level arguments, so a
 * callback nested in the payload object would be structurally cloned rather than proxied, and a
 * function cannot be cloned. See compress.worker.js for the full note.
 *
 * The split is what lets core/queue.js drive this tool exactly like the others: `encodePage` is the
 * per-file unit of work, so a fifty-image batch gets per-file progress, ordered results and a real
 * cancel, with concurrency 1 in the tool because a PDF has to be assembled in memory anyway.
 *
 * Bytes, not blobs, cross the comlink boundary for the page payloads: pdf-lib wants a Uint8Array,
 * and structured cloning handles one directly.
 *
 * PNG passes straight through, other formats are redrawn as JPEG (see engine-pdf's embedStrategy
 * for why the JPEG case cannot be passed through).
 *
 * pdf-lib is imported **lazily**, inside `assemble()` rather than at the top of the file. This
 * worker is created during page load (the tool probes capabilities before it enables the dropzone),
 * so a static import would pull the largest dependency on the site into every visit to
 * /tools/image-to-pdf/ even for a visitor who never builds a PDF. As a dynamic import it becomes a
 * separate chunk fetched only when a document is actually assembled — the same pattern
 * convert.worker.js uses for heic-to.
 */
import * as Comlink from 'comlink';

import { CompressError } from '../core/engine-compress.js';
import { encodeOptions } from '../core/engine-convert.js';
import { embedStrategy, findQuality, planPage, toPdfBox } from '../core/engine-pdf.js';

const controllers = new Map();

/** Probed lazily rather than with a top-level await, so Comlink.expose runs during evaluation. */
let capabilityPromise = null;

function capabilities() {
  if (!capabilityPromise) capabilityPromise = Promise.resolve(detectCapabilities());
  return capabilityPromise;
}

function detectCapabilities() {
  const missing = [];
  if (typeof createImageBitmap !== 'function') missing.push('createImageBitmap');
  if (typeof OffscreenCanvas !== 'function') {
    missing.push('OffscreenCanvas');
    return { supported: false, missing };
  }
  const probe = new OffscreenCanvas(1, 1);
  if (typeof probe.getContext !== 'function') missing.push('OffscreenCanvas.getContext');
  if (typeof probe.convertToBlob !== 'function') missing.push('OffscreenCanvas.convertToBlob');
  return { supported: missing.length === 0, missing };
}

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw { code: 'DECODE_FAILED', message: 'That file could not be decoded as an image.' };
  }
}

/**
 * One image, ready to embed: either its original PNG bytes or a JPEG drawn from the decoded
 * bitmap. Returns the byte length too, so the caller can report progress in real numbers.
 */
async function encodePage(payload = {}, onProgress) {
  const { jobId, file, options = {} } = payload;
  const report = await capabilities();
  if (!report.supported) {
    throw {
      code: 'UNSUPPORTED',
      message: `This browser is missing ${report.missing.join(', ')}, so a PDF cannot be built on your device here.`,
    };
  }
  if (!jobId) throw { code: 'INVALID_JOB', message: 'A page needs a job id.' };
  if (!file || file.size === 0) throw { code: 'INVALID_INPUT', message: 'No image file was provided.' };

  const controller = new AbortController();
  controllers.set(jobId, controller);
  const { signal } = controller;

  try {
    onProgress?.({ jobId, phase: 'probe', ratio: 0.2 });
    const bitmap = await decode(file);
    if (signal.aborted) throw { code: 'ABORTED', message: 'Building the PDF was cancelled.' };

    const strategy = embedStrategy(file.type);
    let bytes;
    let mime;

    if (strategy === 'passthrough') {
      bytes = new Uint8Array(await file.arrayBuffer());
      mime = 'image/png';
    } else {
      const quality = findQuality(options.qualityId)?.quality ?? 0.85;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      // JPEG has no alpha channel; without this the transparent pixels composite to black.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, bitmap.width, bitmap.height);
      context.drawImage(bitmap, 0, 0);
      onProgress?.({ jobId, phase: 'encode', ratio: 0.7 });
      const blob = await canvas.convertToBlob(encodeOptions({ mime: 'image/jpeg', quality }));
      if (!blob || blob.type !== 'image/jpeg') {
        throw { code: 'ENCODE_FAILED', message: 'This browser could not encode a page image.' };
      }
      bytes = new Uint8Array(await blob.arrayBuffer());
      mime = 'image/jpeg';
    }

    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    onProgress?.({ jobId, phase: 'encode', ratio: 1 });

    return {
      bytes,
      mime,
      width: dimensions.width,
      height: dimensions.height,
      strategy,
      bytesLength: bytes.byteLength,
    };
  } catch (error) {
    if (error instanceof CompressError) throw { code: error.code, message: error.message };
    if (signal.aborted) throw { code: 'ABORTED', message: 'Building the PDF was cancelled.' };
    if (error && typeof error.code === 'string') throw error;
    throw { code: 'INTERNAL', message: error?.message || 'One page could not be prepared.' };
  } finally {
    controllers.delete(jobId);
  }
}

/**
 * Assembles the document from prepared pages, in the order given.
 * `pages` is `[{ bytes, mime, width, height }]`.
 */
async function assemble({ pages = [], options = {} } = {}) {
  if (pages.length === 0) throw { code: 'INVALID_INPUT', message: 'There are no images to build a PDF from.' };

  try {
    const { PDFDocument } = await import('pdf-lib');
    const document = await PDFDocument.create();
    document.setTitle(options.title || 'Images');
    // Identifying the producer is honest and useful; nothing here is third-party branding.
    document.setProducer('Browser Image Editor (browser)');
    document.setCreator('Browser Image Editor');

    for (const page of pages) {
      const placement = planPage({
        imageWidth: page.width,
        imageHeight: page.height,
        pageSizeId: options.pageSizeId ?? 'a4',
        marginId: options.marginId ?? 'normal',
      });
      const embedded = page.mime === 'image/png'
        ? await document.embedPng(page.bytes)
        : await document.embedJpg(page.bytes);
      const sheet = document.addPage([placement.pageWidth, placement.pageHeight]);
      sheet.drawImage(embedded, toPdfBox(placement));
    }

    const bytes = await document.save();
    return {
      blob: new Blob([bytes], { type: 'application/pdf' }),
      meta: {
        pages: pages.length,
        bytes: bytes.byteLength,
        pageSizeId: options.pageSizeId ?? 'a4',
        marginId: options.marginId ?? 'normal',
        qualityId: options.qualityId ?? 'balanced',
      },
    };
  } catch (error) {
    if (error && typeof error.code === 'string') throw error;
    throw { code: 'PDF_FAILED', message: error?.message || 'The PDF could not be assembled.' };
  }
}

function cancel(jobId) {
  controllers.get(jobId)?.abort();
}

Comlink.expose({ capabilities, encodePage, assemble, cancel });
