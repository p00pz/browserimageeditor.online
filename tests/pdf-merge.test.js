import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName, PDFString, degrees } from 'pdf-lib';
import { inspectMergeFiles, loadMergeSource, mergePdfFiles, PDF_MERGE_LIMITS } from '../src/assets/js/core/pdf-merge.js';
import { applyMove } from '../src/assets/js/ui/order-list.js';

async function fixture(name, labels = ['A'], { form = false, encrypted = false } = {}) {
  const pdf = await PDFDocument.create();
  for (const [index, label] of labels.entries()) {
    const page = pdf.addPage([300 + index * 10, 500]);
    page.setRotation(degrees(index * 90));
    page.node.set(PDFName.of('TestLabel'), PDFString.of(label));
    page.drawText(label);
  }
  if (form) {
    const field = pdf.getForm().createTextField('name');
    field.setText('Visible form value');
    field.addToPage(pdf.getPage(0), { x: 20, y: 20, width: 200, height: 30 });
  }
  if (encrypted) pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: 'Standard', V: 1 }));
  return new File([await pdf.save({ addDefaultPage: false })], name, { type: 'application/pdf' });
}
const labels = (doc) => doc.getPages().map((page) => page.node.get(PDFName.of('TestLabel')).decodeText());

test('merge copies every page in user order, keeping page boxes, rotation and content', async () => {
  const a = await fixture('a.pdf', ['A1', 'A2']);
  const b = await fixture('b.pdf', ['B1']);
  const c = await fixture('c.pdf', ['C1', 'C2', 'C3']);
  const items = applyMove([{ id: 'a', file: a }, { id: 'b', file: b }, { id: 'c', file: c }], { id: 'c', action: 'first' });
  const ratios = [];
  const result = await mergePdfFiles(items.map(x => x.file), (ratio) => ratios.push(ratio));
  assert.equal(result.blob.type, 'application/pdf');
  assert.equal(result.pages, 6);
  const output = await PDFDocument.load(await result.blob.arrayBuffer());
  assert.deepEqual(labels(output), ['C1', 'C2', 'C3', 'A1', 'A2', 'B1']);
  assert.deepEqual(output.getPages().map(p => p.getWidth()), [300, 310, 320, 300, 310, 300]);
  assert.deepEqual(output.getPages().map(p => p.getRotation().angle), [0, 90, 180, 0, 90, 0]);
  assert.ok(output.getPages().every(p => p.node.Contents() && p.node.Resources()));
  assert.equal(ratios.at(-1), 1);
  assert.ok(ratios.every((ratio, i) => i === 0 || ratio >= ratios[i - 1]));
});

test('inspection rejects invalid and encrypted files individually and keeps valid siblings', async () => {
  const valid = await fixture('good.pdf', ['1', '2']);
  const invalid = new File(['%PDF-1.7\nnot a document'], 'bad.pdf', { type: 'application/pdf' });
  const empty = new File([], 'empty.pdf');
  const wrong = new File(['text'], 'notes.txt', { type: 'text/plain' });
  const encrypted = await fixture('locked.pdf', ['X'], { encrypted: true });
  assert.deepEqual(await inspectMergeFiles([valid, invalid, empty, wrong, encrypted]), [
    { index: 0, pages: 2 }, { index: 1, error: 'INVALID' }, { index: 2, error: 'EMPTY' }, { index: 3, error: 'TYPE' }, { index: 4, error: 'ENCRYPTED' },
  ]);
  const noMime = new File([await valid.arrayBuffer()], 'UPPER.PDF');
  assert.equal((await loadMergeSource(noMime)).getPageCount(), 2);
});

test('limits reject excess before allocating bytes and count only accepted files', async () => {
  const valid = await fixture('good.pdf');
  const oversized = { name: 'large.pdf', type: 'application/pdf', size: PDF_MERGE_LIMITS.fileBytes + 1, arrayBuffer() { throw new Error('should not read'); } };
  await assert.rejects(loadMergeSource(oversized), { code: 'FILE_LIMIT' });
  assert.equal((await inspectMergeFiles([valid], { count: 30 }))[0].error, 'COUNT_LIMIT');
  assert.equal((await inspectMergeFiles([valid], { bytes: PDF_MERGE_LIMITS.totalBytes }))[0].error, 'TOTAL_LIMIT');
  assert.equal((await inspectMergeFiles([valid], { pages: 500 }))[0].error, 'PAGE_LIMIT');
  assert.deepEqual(await inspectMergeFiles([new File(['broken'], 'bad.pdf'), valid], { count: 29 }), [{ index: 0, error: 'INVALID' }, { index: 1, pages: 1 }]);
  await assert.rejects(mergePdfFiles([valid]), { code: 'MIN_FILES' });
  await assert.rejects(mergePdfFiles(Array(31).fill(valid)), { code: 'COUNT_LIMIT' });
});

test('form values are flattened and XFA is rejected rather than producing orphaned fields', async () => {
  const form = await fixture('form.pdf', ['F'], { form: true });
  const normal = await fixture('normal.pdf');
  const result = await mergePdfFiles([form, normal]);
  const output = await PDFDocument.load(await result.blob.arrayBuffer());
  assert.equal(output.getForm().getFields().length, 0);
  assert.equal(output.getPageCount(), 2);
  const xfa = await PDFDocument.load(await normal.arrayBuffer());
  xfa.getForm().acroForm.dict.set(PDFName.of('XFA'), PDFString.of('dynamic'));
  await assert.rejects(loadMergeSource(new File([await xfa.save()], 'xfa.pdf')), { code: 'FORM' });
});

test('any invalid input fails the entire merge instead of silently skipping pages', async () => {
  const valid = await fixture('good.pdf');
  await assert.rejects(mergePdfFiles([valid, new File(['bad'], 'bad.pdf')]), { code: 'INVALID', fileName: 'bad.pdf' });
});
