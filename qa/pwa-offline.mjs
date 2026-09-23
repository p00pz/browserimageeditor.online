import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:4317';
const routes = [
  ['compress-image', 'compress'],
  ['resize-image', 'resize'],
  ['convert-image', 'convert'],
  ['crop-image', 'crop'],
  ['image-to-pdf', 'pdf'],
  ['enhance-photo', 'enhance'],
];
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  for (const [slug, kind] of routes) {
    await context.setOffline(false);
    const url = base + '/tools/' + slug + '/';
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        });
      }
      const channel = new MessageChannel();
      const controller = navigator.serviceWorker.controller;
      const path = location.pathname;
      const warmed = new Promise((resolve, reject) => {
        channel.port1.onmessage = (event) => {
          if (event.data?.type !== 'warm-complete' || event.data.path !== path) return;
          if (event.data.ok) resolve();
          else reject(new Error('Service worker could not cache the full route bundle: ' + path));
        };
        channel.port1.onmessageerror = () => reject(new Error('Service worker warm acknowledgement was unreadable'));
      });
      controller.postMessage({ type: 'warm', path }, [channel.port2]);
      await warmed;
      channel.port1.close();
    });

    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-dropzone-input]').waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-dropzone-input]').disabled);
    await page.locator('[data-sample-image]').click();
    if (kind === 'crop') await page.locator('[data-crop-apply]').click({ timeout: 10000 });
    if (kind === 'pdf') await page.locator('[data-build-pdf]').click({ timeout: 10000 });
    await page.locator('[data-result]:not([hidden])').waitFor({ timeout: 45000 });

    const output = await page.evaluate(async () => {
      const link = document.querySelector('[data-download]');
      if (!link?.href.startsWith('blob:')) return null;
      const blob = await (await fetch(link.href)).blob();
      return { size: blob.size, type: blob.type };
    });
    assert.ok(output && output.size > 0, kind + ' must produce output with the network offline');
    if (kind === 'pdf') assert.equal(output.type, 'application/pdf', 'offline PDF must be a real PDF');
    if (kind === 'convert') {
      const fetchedHeic = await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => /heic-to|heic/i.test(entry.name)));
      assert.equal(fetchedHeic, false, 'ordinary Convert visit must keep the HEIC decoder first-use lazy');
    }
    console.log('PASS offline: ' + slug + ' (' + output.type + ', ' + output.size + ' bytes)');
  }
  assert.deepEqual(errors, [], 'no uncaught browser errors during offline processing');
} finally {
  await context.setOffline(false);
  await browser.close();
}
