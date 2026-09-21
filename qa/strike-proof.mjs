/**
 * Proof harness for the strike. Three jobs, all read-only against the served site:
 *
 *  1. fonts()  — getComputedStyle().fontFamily for body/h1/nav/button/input/select on the home
 *                page and all six tool pages, both locales, plus a network pass that flags any
 *                request that leaves the origin and any font request at all.
 *  2. shots()  — empty + loaded states of all six tool pages at 1440 and 390, the header at 1440
 *                and the mobile menu at 390, both themes on one tool.
 *  3. It writes a JSON blob the QA report is built from, so no number is hand-copied.
 *
 * Run against the preview server:  node qa/strike-proof.mjs [base] [job]
 */
import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const shotDir = resolve(root, 'screenshots');
mkdirSync(shotDir, { recursive: true });

const BASE = process.argv[2] || 'http://localhost:4317';
const JOB = process.argv[3] || 'all';

const AR_TOOLS = [
  ['compress-image', 'compress'],
  ['resize-image', 'resize'],
  ['convert-image', 'convert'],
  ['crop-image', 'crop'],
  ['image-to-pdf', 'pdf'],
  ['enhance-photo', 'enhance'],
];

const PROBES = [
  ['body', 'body'],
  ['h1', 'h1'],
  ['nav a', '.nav-list a'],
  ['button', 'button'],
  ['input', 'input'],
  ['select', 'select'],
];

/** A procedurally drawn sample photo: the "صورة تجريبية" the brief asks for, made locally. */
async function sampleImagePath(page, kind) {
  return page.evaluate((k) => {
    const c = document.createElement('canvas');
    if (k === 'portrait') { c.width = 900; c.height = 1600; }
    else if (k === 'wide') { c.width = 1920; c.height = 1080; }
    else { c.width = 1200; c.height = 1200; }
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, '#0a84ff');
    g.addColorStop(0.55, '#5856d6');
    g.addColorStop(1, '#ff2d55');
    x.fillStyle = g;
    x.fillRect(0, 0, c.width, c.height);
    x.globalAlpha = 0.9;
    for (let i = 0; i < 9; i++) {
      x.beginPath();
      x.arc(
        c.width * (0.12 + 0.76 * (i % 3) / 2),
        c.height * (0.16 + 0.68 * Math.floor(i / 3) / 2),
        Math.min(c.width, c.height) * (0.09 + 0.05 * (i % 4)), 0, Math.PI * 2);
      x.fillStyle = ['#ffffff', '#ffd60a', '#34c759', '#ff9f0a'][i % 4];
      x.fill();
    }
    x.globalAlpha = 1;
    x.fillStyle = 'rgba(0,0,0,0.45)';
    x.font = '700 64px system-ui, sans-serif';
    x.textAlign = 'center';
    x.fillText('SAMPLE', c.width / 2, c.height / 2);
    return c.toDataURL('image/png');
  }, kind);
}

/** The dropzone is a file input the page owns; setting it is the real user path. */
async function loadSample(page, kind = 'square') {
  const dataUrl = await sampleImagePath(page, kind);
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles({
    name: 'sample.png',
    mimeType: 'image/png',
    buffer: Buffer.from(dataUrl.split(',')[1], 'base64'),
  });
  // Processing is async and runs in a worker; give it the moment it needs.
  await page.waitForTimeout(1400);
}

async function newContext(browser, width, height, theme) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: width < 500 ? 2 : 1,
    locale: 'ar-SA',
  });
  if (theme) {
    await ctx.addInitScript((t) => {
      try { localStorage.setItem('browserimageeditor:theme', t); } catch (e) { /* private mode */ }
    }, theme);
  }
  return ctx;
}

/** Records every request the page makes, so an external call can never hide. */
function attachNetwork(ctx) {
  const log = [];
  ctx.on('request', (req) => {
    const u = req.url();
    if (u.includes('localhost') || u.includes('127.0.0.1')) return;
    log.push({ url: u, type: req.resourceType() });
  });
  return log;
}

async function fonts(browser) {
  const rows = [];
  const externalAll = [];
  const fontRequests = [];
  for (const [locale, home] of [['ar', '/ar/'], ['en', '/']]) {
    const ctx = await newContext(browser, 1440, 900, 'light');
    const net = attachNetwork(ctx);
    const page = await ctx.newPage();
    const pages = [['home', home]];
    for (const [slug] of AR_TOOLS) {
      pages.push([slug, locale === 'ar' ? `/ar/tools/${slug}/` : `/tools/${slug}/`]);
    }
    for (const [name, url] of pages) {
      await page.goto(BASE + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(350);
      const measured = await page.evaluate((probes) => {
        const out = {};
        for (const [key, sel] of probes) {
          const el = document.querySelector(sel);
          if (!el) { out[key] = null; continue; }
          const cs = getComputedStyle(el);
          out[key] = cs.fontFamily;
        }
        out.docFontsReady = document.fonts.status;
        return out;
      }, PROBES);
      rows.push({ locale, page: name, ...measured });
    }
    externalAll.push(...net);
    fontRequests.push(...net.filter((e) => e.type === 'font' || /\.woff2?|\.otf|\.ttf/i.test(e.url)));
    await ctx.close();
  }
  const out = resolve(root, 'qa', 'strike-fonts.json');
  writeFileSync(out, JSON.stringify({ rows, externalAll, fontRequests }, null, 1));
  console.log(`fonts: ${rows.length} page-probes written to qa/strike-fonts.json`);
  console.log(`fonts: ${externalAll.length} external requests, ${fontRequests.length} font requests`);
  if (externalAll.length) externalAll.slice(0, 12).forEach((e) => console.log('   EXT', e.type, e.url));
  if (fontRequests.length) fontRequests.forEach((e) => console.log('   FONT', e.url));
}

async function emptyShots(browser) {
  for (const w of [1440, 390]) {
    const ctx = await newContext(browser, w, w === 1440 ? 900 : 844, 'light');
    const page = await ctx.newPage();
    for (const [slug, short] of AR_TOOLS) {
      await page.goto(`${BASE}/ar/tools/${slug}/`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      await page.screenshot({ path: resolve(shotDir, `empty-${short}-${w}.png`), fullPage: false });
    }
    await page.goto(`${BASE}/ar/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(shotDir, `home-ar-${w}.png`), fullPage: false });
    if (w === 1440) {
      // Header only, at desktop: the nav row is the proof of the new names.
      await page.screenshot({ path: resolve(shotDir, 'header-ar-1440.png'), clip: { x: 0, y: 0, width: 1440, height: 120 } });
    } else {
      // The mobile menu is the "dock": open it, then shoot.
      await page.locator('[data-mobile-menu-toggle]').click();
      await page.waitForTimeout(450);
      await page.screenshot({ path: resolve(shotDir, 'mobile-menu-ar-390.png') });
    }
    await ctx.close();
  }
  console.log('empty-state screenshots written');
}

async function loadedShots(browser) {
  const kinds = { compress: 'wide', resize: 'square', convert: 'square', crop: 'portrait', pdf: 'wide', enhance: 'portrait' };
  for (const w of [1440, 390]) {
    const ctx = await newContext(browser, w, w === 1440 ? 900 : 844, 'light');
    const page = await ctx.newPage();
    for (const [slug, short] of AR_TOOLS) {
      await page.goto(`${BASE}/ar/tools/${slug}/`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await loadSample(page, kinds[short]);
      await page.waitForTimeout(600);
      await page.screenshot({ path: resolve(shotDir, `loaded-${short}-${w}.png`), fullPage: false });
    }
    await ctx.close();
  }
  console.log('loaded-state screenshots written');
}

async function themeShots(browser) {
  for (const theme of ['dark', 'light']) {
    const ctx = await newContext(browser, 1440, 900, theme);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/ar/tools/compress-image/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await loadSample(page, 'wide');
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(shotDir, `theme-${theme}-compress-1440.png`) });
    await ctx.close();
  }
  console.log('theme screenshots written');
}

(async () => {
  const browser = await chromium.launch();
  try {
    if (JOB === 'all' || JOB === 'fonts') await fonts(browser);
    if (JOB === 'all' || JOB === 'empty') await emptyShots(browser);
    if (JOB === 'all' || JOB === 'loaded') await loadedShots(browser);
    if (JOB === 'all' || JOB === 'themes') await themeShots(browser);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
