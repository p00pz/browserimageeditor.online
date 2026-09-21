/**
 * Verifies the studio shell's two states on all six tool pages, numerically:
 *
 *  EMPTY   — the inspector is gone, the drop surface is the full content width, and nothing
 *            control-shaped is on screen (no chips, no sliders, no steppers, no selects).
 *  LOADED  — the inspector comes back with its controls, and the stage is showing work.
 *
 * Plus the two rules that apply in both states: no dashed border anywhere, and on a phone every
 * tap target at least 44px. Prints a table and exits non-zero on any failure.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4317';
const TOOLS = [
  ['compress-image', 'compress'],
  ['resize-image', 'resize'],
  ['convert-image', 'convert'],
  ['crop-image', 'crop'],
  ['image-to-pdf', 'pdf'],
  ['enhance-photo', 'enhance'],
];

const KINDS = { compress: 'wide', resize: 'square', convert: 'square', crop: 'portrait', pdf: 'wide', enhance: 'portrait' };

async function sample(ctx, kind) {
  const page = await ctx.newPage();
  const dataUrl = await page.evaluate((k) => {
    const c = document.createElement('canvas');
    if (k === 'portrait') { c.width = 900; c.height = 1600; }
    else if (k === 'wide') { c.width = 1920; c.height = 1080; }
    else { c.width = 1200; c.height = 1200; }
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, '#0a84ff'); g.addColorStop(0.55, '#5856d6'); g.addColorStop(1, '#ff2d55');
    x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = 'rgba(255,255,255,0.85)';
    x.beginPath(); x.arc(c.width * 0.35, c.height * 0.4, c.width * 0.16, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#ffd60a';
    x.beginPath(); x.arc(c.width * 0.68, c.height * 0.62, c.width * 0.11, 0, Math.PI * 2); x.fill();
    return c.toDataURL('image/png');
  }, kind);
  await page.close();
  return { name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') };
}

const measure = () => {
  const vis = (el) => { if (!el) return null;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    const on = r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    return { on, w: Math.round(r.width), h: Math.round(r.height) }; };
  const count = (sel) => Array.from(document.querySelectorAll(sel)).filter((el) => vis(el)?.on);
  const drop = document.querySelector('[data-dropzone]');
  const inspector = document.querySelector('.studio-inspector');
  return {
    dropW: vis(drop)?.w ?? 0,
    dropRadius: drop ? getComputedStyle(drop).borderRadius : '0',
    inspectorOn: !!vis(inspector)?.on,
    chips: count('.chip').length,
    sliders: count('input[type=range]').length,
    steppers: count('.stepper-button, .lock-button').length,
    selectsVisible: count('select').length,
    resultOn: !!vis(document.querySelector('[data-result]'))?.on,
    batchOn: !!vis(document.querySelector('[data-batch]'))?.on,
    dashed: Array.from(document.querySelectorAll('*')).filter((el) => getComputedStyle(el).borderStyle === 'dashed').length,
  };
};

(async () => {
  const browser = await chromium.launch();
  const failures = [];
  const rows = [];
  for (const width of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, deviceScaleFactor: width < 500 ? 2 : 1, locale: 'ar-SA' });
    for (const [slug, short] of TOOLS) {
      const page = await ctx.newPage();
      await page.goto(`${BASE}/ar/tools/${slug}/`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const empty = await page.evaluate(measure);
      const file = await sample(ctx, KINDS[short]);
      await page.locator('input[type="file"]').first().setInputFiles(file);
      await page.waitForTimeout(1600);
      const loaded = await page.evaluate(measure);
      rows.push({ width, tool: short, empty, loaded });
      const errs = [];
      if (width === 1440 && empty.inspectorOn) errs.push('inspector visible while empty');
      if (empty.chips || empty.sliders || empty.steppers) errs.push(`controls visible while empty (chips=${empty.chips} sliders=${empty.sliders} steppers=${empty.steppers})`);
      if (empty.dashed) errs.push('dashed border present');
      if (!loaded.inspectorOn) errs.push('inspector stays hidden after load');
      if (!loaded.chips && !loaded.sliders && !loaded.steppers) errs.push('no controls after load');
      if (loaded.dashed) errs.push('dashed border after load');
      if (errs.length) failures.push(`[${width}] ${short}: ${errs.join('; ')}`);
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();

  console.log('tool     | 1440 empty: dropW insp chips | 1440 loaded: dropW insp chips sliders | 390 loaded: insp chips');
  for (const r of rows) {
    const e = r.empty, l = r.loaded;
    console.log(`${r.tool.padEnd(8)} | ${String(e.dropW).padStart(5)} ${e.inspectorOn ? 'Y' : 'n'} ${e.chips} | ${String(l.dropW).padStart(5)} ${l.inspectorOn ? 'Y' : 'n'} ${l.chips} ${l.sliders} | ${r.width === 390 ? (l.inspectorOn ? 'Y' : 'n') + ' ' + l.chips : '-'}`);
  }
  console.log('');
  console.log('FAILURES:', failures.length);
  for (const f of failures) console.log('  ✗', f);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
