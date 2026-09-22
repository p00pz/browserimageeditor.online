import { planDocument, toPdfBox } from './engine-pdf.js';

/** One assembler for worker and main-thread fallback; pdf-lib loads only on export. */
export async function createPdf(pages, options, signal) {
  const check = () => { if (signal?.aborted) throw { code: 'ABORTED', message: 'PDF creation was cancelled.' }; };
  if (!pages.length) throw { code: 'INVALID_INPUT', message: 'Choose at least one image.' };
  const layout = planDocument(pages, options);
  const { PDFDocument } = await import('pdf-lib');
  check();
  const doc = await PDFDocument.create();
  doc.setTitle(options.title || 'Images');
  doc.setCreator('Browser Image Editor');
  doc.setProducer('Browser Image Editor');
  for (const plan of layout) {
    const sheet = doc.addPage([plan.pageWidth, plan.pageHeight]);
    for (const cell of plan.cells) {
      check();
      const image = pages[cell.index];
      const embedded = image.mime === 'image/png' ? await doc.embedPng(image.bytes) : await doc.embedJpg(image.bytes);
      sheet.drawImage(embedded, toPdfBox(cell));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  check();
  const bytes = await doc.save({ objectsPerTick: 20 });
  check();
  return { blob: new Blob([bytes], { type: 'application/pdf' }), meta: {
    pages: layout.length, images: pages.length, bytes: bytes.byteLength,
    pageSizeId: options.pageSizeId ?? 'a4', marginId: options.marginId ?? 'normal', qualityId: options.qualityId ?? 'balanced',
  } };
}
