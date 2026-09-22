import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { planDocument } from '../src/assets/js/core/engine-pdf.js';
import { createPdf } from '../src/assets/js/core/pdf-document.js';

const images = Array.from({ length: 201 }, (_, i) => ({ width: i % 2 ? 600 : 1600, height: i % 2 ? 1600 : 600 }));
for (const count of [1, 2, 4, 6, 9]) for (const orientation of ['portrait', 'landscape']) {
  test(`${count} images/page, ${orientation}: odd and large sets preserve geometry and order`, () => {
    for (const length of [1, 7, 12, 201]) {
      const plans = planDocument(images.slice(0, length), { imagesPerPage: count, orientation, marginPoints: 36, gapPoints: 12 });
      assert.equal(plans.length, Math.ceil(length / count));
      assert.deepEqual(plans.flatMap((page) => page.cells.map((cell) => cell.index)), Array.from({length}, (_, i) => i));
      for (const page of plans) for (const cell of page.cells) {
        assert.ok(cell.x >= 36 && cell.y >= 36);
        assert.ok(cell.x + cell.drawWidth <= page.pageWidth - 36 + .001);
        assert.ok(cell.y + cell.drawHeight <= page.pageHeight - 36 + .001);
        assert.ok(Math.abs(cell.drawWidth / cell.drawHeight - images[cell.index].width / images[cell.index].height) < .00001);
        for (const other of page.cells.filter((c) => c.index !== cell.index)) {
          assert.ok(cell.x + cell.drawWidth <= other.x || other.x + other.drawWidth <= cell.x || cell.y + cell.drawHeight <= other.y || other.y + other.drawHeight <= cell.y);
        }
      }
    }
  });
}
test('PDF planner rejects invalid grids and spacing', () => {
  for (const options of [{ imagesPerPage: 3 }, { gapPoints: -1 }, { marginPoints: 500 }, { orientation: 'diagonal' }, { pageSizeId: 'match', imagesPerPage: 4 }]) assert.throws(() => planDocument(images.slice(0, 2), options));
});
test('export writes the actual grid page count and supports cancellation', async () => {
  const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
  const pages = Array.from({ length: 12 }, () => ({ bytes, mime: 'image/png', width: 1, height: 1 }));
  const { blob, meta } = await createPdf(pages, { imagesPerPage: 4, orientation: 'landscape' });
  const pdf = await PDFDocument.load(await blob.arrayBuffer());
  assert.equal(meta.pages, 3);
  assert.equal(pdf.getPageCount(), 3);
  assert.ok(pdf.getPage(0).getWidth() > pdf.getPage(0).getHeight());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createPdf(pages, {}, controller.signal), (error) => error.code === 'ABORTED');
});
