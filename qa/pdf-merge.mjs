import { chromium, webkit } from 'playwright';
import { PDFDocument, PDFName, PDFString, degrees } from 'pdf-lib';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] ?? process.env.PREVIEW_URL ?? 'http://127.0.0.1:4317';
const out = process.env.QA_PDF_OUT ?? 'qa/shots/pdf-merge';
mkdirSync(out, { recursive: true });
async function fixture(name, labels, encrypted = false) {
  const doc = await PDFDocument.create();
  for (const [index, text] of labels.entries()) {
    const page = doc.addPage([300 + index * 25, 500]);
    page.setRotation(degrees(index * 90));
    page.node.set(PDFName.of('TestLabel'), PDFString.of(text));
    page.drawText(text, { x: 40, y: 400 });
  }
  if (encrypted) doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1 }));
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) };
}
const a = await fixture('first-document.pdf', ['A1', 'A2']);
const b = await fixture('second-document.pdf', ['B1']);
const c = await fixture('additional-document-with-a-long-file-name.pdf', ['C1', 'C2']);
const locked = await fixture('locked.pdf', ['LOCKED'], true);
const bad = { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\ninvalid') };
const sizes = [320, 390, 768, 1440];
const reports = [];
for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch();
  try {
    for (const locale of ['', '/ar']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
      const errors = [];
      const external = [];
      context.on('request', (request) => {
        if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(base).origin) external.push(request.url());
        assert.equal(request.method(), 'GET', 'PDF processing must not upload data');
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base + locale + '/tools/merge-pdf/', { waitUntil: 'networkidle' });
      const input = page.locator('[data-dropzone-input]');
      const merge = page.locator('[data-merge]');
      const names = () => page.locator('.order-item-name').allTextContents();
      const idle = () => page.waitForFunction(() => document.querySelector('[data-tool-root]').getAttribute('aria-busy') !== 'true');
      assert.equal(await merge.isDisabled(), true);
      assert.equal(await page.locator('.dropzone-title').isVisible(), true);
      await page.screenshot({ path: join(out, `${engineName}-${locale ? 'ar' : 'en'}-empty.png`), fullPage: true });
      await input.setInputFiles([a, bad, b, locked]);
      await idle();
      assert.deepEqual(await names(), [a.name, b.name]);
      assert.equal(await page.locator('[data-errors] li').count(), 2);
      assert.ok((await page.locator('[data-errors]').textContent()).includes(locked.name));
      assert.equal(await merge.isEnabled(), true);
      assert.equal(await page.locator('.dropzone-browse').isVisible(), true, 'adding more PDFs remains discoverable');
      // A blocked Worker constructor (including DOM numeric error codes) must still have readable copy.
      await page.evaluate(() => { window.qaWorker = window.Worker; window.Worker = class { constructor() { throw new DOMException('Blocked', 'SecurityError'); } }; });
      await merge.click();
      await idle();
      assert.equal(await page.locator('[data-errors] li').count(), 1);
      assert.ok(!(await page.locator('[data-errors]').textContent()).includes('js.merge.error.'));
      assert.deepEqual(await names(), [a.name, b.name]);
      await page.evaluate(() => { window.Worker = window.qaWorker; delete window.qaWorker; });
      const up = page.locator('.order-item').nth(1).locator('[data-action="up"]');
      await up.focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(await names(), [b.name, a.name]);
      assert.equal(await page.evaluate(() => document.activeElement.closest('.order-item').querySelector('.order-item-name').textContent), b.name);
      await input.setInputFiles(c);
      await idle();
      await page.locator('.order-item').nth(1).locator('[data-action="remove"]').click();
      assert.deepEqual(await names(), [b.name, c.name]);

      // Cancel in the same user turn so the real worker is terminated before it can finish.
      await page.evaluate(() => { document.querySelector('[data-merge]').click(); document.querySelector('[data-cancel]').click(); });
      await idle();
      assert.equal(await page.locator('[data-result]').isHidden(), true);
      assert.deepEqual(await names(), [b.name, c.name]);
      assert.equal(await merge.isEnabled(), true);

      async function downloadAndCheck(expected, suffix) {
        await merge.click();
        await page.locator('[data-result]').waitFor({ state: 'visible' });
        const event = page.waitForEvent('download');
        await page.locator('[data-download]').click();
        const download = await event;
        assert.equal(download.suggestedFilename(), 'browserimageeditor-merged.pdf');
        assert.equal(await download.failure(), null);
        const file = join(out, `${engineName}-${locale ? 'ar' : 'en'}-${suffix}.pdf`);
        await download.saveAs(file);
        const output = await PDFDocument.load(readFileSync(file));
        assert.deepEqual(output.getPages().map(p => p.node.get(PDFName.of('TestLabel')).decodeText()), expected);
        return file;
      }
      await downloadAndCheck(['B1', 'C1', 'C2'], 'first');
      const oldUrl = await page.locator('[data-download]').getAttribute('href');
      await page.locator('.order-item').nth(1).locator('[data-action="first"]').click();
      assert.equal(await page.locator('[data-result]').isHidden(), true);
      assert.equal(await page.locator('[data-download]').getAttribute('href'), null);
      assert.equal(await page.evaluate(async (url) => { try { await fetch(url); return false; } catch { return true; } }, oldUrl), true);
      await downloadAndCheck(['C1', 'C2', 'B1'], 'reordered');

      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.dataset.theme = theme; }, theme);
        for (const width of sizes) {
          await page.setViewportSize({ width, height: width === 768 ? 1024 : 900 });
          await page.evaluate(() => scrollTo(0, 0));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${engineName} ${locale} ${theme} ${width}: horizontal overflow`);
          const targets = await page.locator('.order-button, [data-merge], [data-clear], [data-download]').evaluateAll((elements) => elements.map(element => { const r = element.getBoundingClientRect(); return [r.width, r.height]; }));
          assert.ok(targets.every(([w, h]) => w >= 44 && h >= 44), 'all ordering and save buttons must be touch-sized');
          await page.screenshot({ path: join(out, `${engineName}-${locale ? 'ar' : 'en'}-${theme}-${width}.png`), fullPage: true });
        }
      }
      await page.locator('[data-clear]').click();
      assert.equal(await page.locator('.order-item').count(), 0);
      assert.equal(await merge.isDisabled(), true);
      assert.equal(await page.locator('[data-result]').isHidden(), true);
      // Drop uses the same file intake path as selection.
      await page.evaluate((payloads) => {
        const dataTransfer = new DataTransfer();
        for (const payload of payloads) dataTransfer.items.add(new File([new Uint8Array(payload.bytes)], payload.name, { type: 'application/pdf' }));
        document.querySelector('[data-dropzone]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      }, [a, b].map(f => ({ name: f.name, bytes: [...f.buffer] })));
      await idle();
      assert.deepEqual(await names(), [a.name, b.name]);
      await page.goto(base + locale + '/', { waitUntil: 'networkidle' });
      await page.evaluate(() => scrollTo(0, 0));
      assert.equal(await page.locator('.pdf-promo a').getAttribute('href'), locale + '/tools/merge-pdf/');
      await page.screenshot({ path: join(out, `${engineName}-${locale ? 'ar' : 'en'}-home.png`), fullPage: true });
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      reports.push(`${engineName} ${locale || 'en'}: selection, rejection, keyboard ordering, append/remove, cancel/retry, downloads, stale URLs, clear/drop, responsive light/dark and promo passed`);
      await context.close();
    }
  } finally { await browser.close(); }
}
console.log(reports.join('\n'));
