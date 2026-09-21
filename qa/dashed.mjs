import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://localhost:4317';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar-SA' });
const page = await ctx.newPage();
await page.goto(`${BASE}/ar/tools/crop-image/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const dataUrl = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 900;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, c.width, c.height);
  g.addColorStop(0, '#0a84ff'); g.addColorStop(1, '#ff2d55');
  x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
  return c.toDataURL('image/png');
});
await page.locator('input[type="file"]').first().setInputFiles({
  name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64'),
});
await page.waitForTimeout(1800);
const dashed = await page.evaluate(() => Array.from(document.querySelectorAll('*'))
  .filter((el) => getComputedStyle(el).borderStyle === 'dashed')
  .map((el) => ({ tag: el.tagName, cls: el.className?.toString().slice(0, 60), id: el.id || null,
    inside: el.closest('.cropper-container') ? 'cropperjs' : (el.closest('[data-dropzone]') ? 'dropzone' : 'other') })));
console.log(JSON.stringify(dashed, null, 1));
await browser.close();
