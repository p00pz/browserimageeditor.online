// Dumps the empty-state structure of a tool page: what is visible, and with what geometry.
// Used to prove the "nothing else is visible in the empty state" requirement numerically.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4317';
const slug = process.argv[3] || 'compress-image';
const width = parseInt(process.argv[4] || '1440', 10);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, locale: 'ar-SA' });
const page = await ctx.newPage();
await page.goto(`${BASE}/ar/tools/${slug}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const report = await page.evaluate(() => {
  const visible = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const onScreen = r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    return { box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, onScreen, radius: cs.borderRadius, border: cs.borderStyle + ' ' + cs.borderWidth + ' ' + cs.borderColor, fontSize: cs.fontSize, fontFamily: cs.fontFamily.slice(0, 40) };
  };
  const pick = (sel) => Array.from(document.querySelectorAll(sel)).map(visible);
  return {
    stage: visible(document.querySelector('.studio-stage')),
    inspector: visible(document.querySelector('.studio-inspector')),
    selects: pick('select').map((s, i) => ({ i, ...s, ariaHidden: document.querySelectorAll('select')[i].getAttribute('aria-hidden'), classes: document.querySelectorAll('select')[i].className })),
    drop: visible(document.querySelector('.dropzone, .drop-surface, [data-dropzone]')),
    chips: pick('.chip').filter((c) => c.onScreen).length,
    sliders: pick('input[type=range]').filter((c) => c.onScreen).length,
    stepperBtns: pick('.stepper-button, .lock-button').filter((c) => c.onScreen).length,
    // anything with a dashed border anywhere on the page
    dashed: Array.from(document.querySelectorAll('*')).filter((el) => getComputedStyle(el).borderStyle === 'dashed').map((el) => el.className || el.tagName),
    buttons: pick('button').filter((c) => c.onScreen).length,
    h1: visible(document.querySelector('h1')),
    bodyText: getComputedStyle(document.body).fontSize,
  };
});
console.log(JSON.stringify(report, null, 1));
await browser.close();
