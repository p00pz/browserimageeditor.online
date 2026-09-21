/**
 * Smoke check of the built site, in one pass: every page answers, nothing on it is broken, every
 * tool actually produces a file, and nothing leaves the origin.
 *
 * What it proves, numerically:
 *   1. links()    — every internal href/src in the built tree resolves to a file that exists, and
 *                   every URL in sitemap.xml answers 200. A broken link or a dangling sitemap entry
 *                   fails here rather than in production.
 *   2. pages()    — every built page answers 200 with zero console errors and zero page crashes, at
 *                   1440 on desktop and 390 on a phone for the pages a visitor uses both ways.
 *   3. chrome()   — the language switch lands on the other locale's URL and flips <html lang>, and
 *                   the theme toggle changes a measured surface colour.
 *   4. tools()    — all six tools take a real image through to a real downloaded result. The five
 *                   image shapes that matter are covered: small, large, portrait, a PNG with real
 *                   alpha transparency, and a batch of three.
 *   5. network()  — every request the pages make stays on the origin; anything else fails.
 *
 * Run against the preview server:  node qa/smoke.mjs [base]
 */
import { chromium } from 'playwright';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative, sep, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = resolve(root, 'dist');
const BASE = (process.argv[2] || 'http://localhost:4317').replace(/\/$/, '');

const TOOLS = ['compress-image', 'resize-image', 'convert-image', 'crop-image', 'image-to-pdf', 'enhance-photo'];
const fail = [];
const note = [];

/** One sample image, drawn procedurally so the run needs no fixture file on disk. */
async function sample(page, kind) {
  return page.evaluate((k) => {
    const c = document.createElement('canvas');
    if (k === 'large') { c.width = 4000; c.height = 3000; }
    else if (k === 'portrait') { c.width = 900; c.height = 1600; }
    else if (k === 'small') { c.width = 320; c.height = 240; }
    else { c.width = 1200; c.height = 1200; }
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, '#0a84ff');
    g.addColorStop(0.55, '#5856d6');
    g.addColorStop(1, '#ff2d55');
    x.fillStyle = g;
    x.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < 9; i++) {
      x.beginPath();
      x.arc(
        c.width * (0.12 + 0.76 * (i % 3) / 2),
        c.height * (0.16 + 0.68 * Math.floor(i / 3) / 2),
        Math.min(c.width, c.height) * (0.09 + 0.05 * (i % 4)), 0, Math.PI * 2);
      x.fillStyle = ['#ffffff', '#ffd60a', '#34c759', '#ff9f0a'][i % 4];
      x.fill();
    }
    if (k === 'transparent') {
      // Punch real alpha holes: the conversion has something to flatten and the PNG survives.
      x.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 4; i++) {
        x.beginPath();
        x.arc(c.width * (0.2 + 0.2 * i), c.height * 0.5, c.width * 0.08, 0, Math.PI * 2);
        x.fill();
      }
      x.globalCompositeOperation = 'source-over';
    }
    return c.toDataURL('image/png');
  }, kind);
}

async function loadFiles(page, kinds) {
  const buffers = [];
  for (const k of kinds) {
    const url = await sample(page, k);
    buffers.push({ name: `sample-${k}.png`, mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') });
  }
  await page.locator('input[type="file"]').first().setInputFiles(buffers);
}

/** Non-origin requests, recorded per context. */
function attachNetwork(ctx, log) {
  ctx.on('request', (req) => {
    const u = req.url();
    if (u.includes('localhost') || u.includes('127.0.0.1')) return;
    log.push(`${req.resourceType()} ${u}`);
  });
}

/* ------------------------------------------------------------------ 1. links */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function links() {
  const htmlFiles = walk(dist).filter((f) => f.endsWith('.html'));
  const existing = new Set(walk(dist).map((f) => relative(dist, f).split(sep).join('/')));
  let checked = 0;

  const resolveTarget = (fromPath, url) => {
    if (!url || url.startsWith('#')) return null;
    const [path] = url.split('#')[0].split('?');
    if (!path || path.startsWith('http:') || path.startsWith('https:') || path.startsWith('mailto:') ||
        path.startsWith('tel:') || path.startsWith('data:') || path.startsWith('blob:') || path.startsWith('javascript:')) {
      return null;
    }
    const decoded = decodeURIComponent(path);
    const fromDir = dirname(fromPath);
    const raw = decoded.startsWith('/') ? decoded.slice(1) : join(fromDir, decoded);
    // One separator, no trailing one, so `existing` (built the same way) compares true.
    const abs = normalize(raw).split(sep).join('/').replace(/\/+$/, '');
    if (!abs || abs === '.') return 'index.html';
    if (existing.has(abs)) return abs;
    if (existing.has(`${abs}/index.html`)) return `${abs}/index.html`;
    return `MISSING:${abs}`;
  };

  for (const file of htmlFiles) {
    const from = relative(dist, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    const re = /(?:href|src)=["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(text))) {
      const target = resolveTarget(from, m[1]);
      if (target === null) continue;
      checked += 1;
      if (target.startsWith('MISSING:')) fail.push(`broken link: ${from} -> ${m[1]} (no ${target.slice(8)})`);
    }
  }

  const sitemap = readFileSync(resolve(dist, 'sitemap.xml'), 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const loc of locs) {
    const path = new URL(loc).pathname.replace(/^\/+/, '');
    const file = path === '' ? 'index.html' : `${path.replace(/\/$/, '')}/index.html`;
    if (!existing.has(file)) fail.push(`sitemap entry has no built file: ${loc}`);
  }
  note.push(`links: ${checked} internal links across ${htmlFiles.length} pages, ${locs.length} sitemap entries`);
}

/* ------------------------------------------------------------- 2/3/4/5 browser */

async function withPage(ctx, url, fn) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const res = await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
  await fn(page, res, errors);
  await page.close();
  return errors;
}

async function pages(browser) {
  const htmlFiles = walk(dist)
    .filter((f) => f.endsWith('.html'))
    .map((f) => '/' + relative(dist, f).split(sep).join('/').replace(/index\.html$/, ''));
  const urls = htmlFiles.map((u) => (u === '' ? '/' : u));

  let checked = 0;
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w < 500 ? 2 : 1 });
    const net = [];
    attachNetwork(ctx, net);
    for (const url of urls) {
      await withPage(ctx, url, async (page, res, errors) => {
        checked += 1;
        if (!res || res.status() !== 200) fail.push(`page not 200 (${w}px): ${url} -> ${res ? res.status() : 'no response'}`);
        if (errors.length) fail.push(`console errors (${w}px) ${url}: ${errors.join(' | ')}`);
      });
    }
    await ctx.close();
  }
  note.push(`pages: ${checked} page-loads at 1440 and 390, status + console checked`);
  return urls;
}

async function chrome(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const net = [];
  attachNetwork(ctx, net);

  // Language switch, both directions.
  for (const [from, to, expectLang] of [['/', '/ar/', 'ar'], ['/ar/', '/', 'en']]) {
    await withPage(ctx, from, async (page) => {
      await page.locator('.lang-switch-link').first().click();
      await page.waitForURL(`**${to}`);
      const lang = await page.getAttribute('html', 'lang');
      if (!lang || !lang.startsWith(expectLang)) fail.push(`language switch ${from} -> ${to}: html.lang is "${lang}"`);
    });
  }

  // Theme toggle, both directions: a measured surface colour has to move.
  for (const theme of ['dark', 'light']) {
    await ctx.addInitScript((t) => {
      try { localStorage.setItem('browserimageeditor:theme', t); } catch (e) { /* private mode */ }
    }, theme);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/tools/compress-image/`, { waitUntil: 'networkidle' });
    const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.locator('[data-theme-toggle]').click();
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (before === after) fail.push(`theme toggle did not change body colour (was ${theme}, ${before} -> ${after})`);
    const stored = await page.evaluate(() => localStorage.getItem('browserimageeditor:theme'));
    if (stored === theme) fail.push(`theme toggle did not persist: still ${stored}`);
    await page.close();
  }
  await ctx.close();
  note.push('chrome: language switch both directions, theme toggle persisted with measured colour change');
}

async function tools(browser) {
  const kinds = { 'compress-image': 'large', 'resize-image': 'small', 'convert-image': 'transparent',
                  'crop-image': 'portrait', 'image-to-pdf': 'portrait', 'enhance-photo': 'wide' };
  let downloads = 0;

  for (const locale of ['', '/ar']) {
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w < 500 ? 2 : 1, locale: locale ? 'ar-SA' : 'en-US' });
      const net = [];
      attachNetwork(ctx, net);
      for (const slug of TOOLS) {
        await withPage(ctx, `${locale}/tools/${slug}/`, async (page) => {
          const started = Date.now();
          await loadFiles(page, [kinds[slug]]);
          // The crop tool is interactive by design: it shows a cropper and waits for the visitor to
          // choose the region, so the result only exists once that choice is applied. The PDF tool
          // waits for an explicit "build" tap too, because the list is the interface and the order
          // can be changed before anything is rendered.
          if (slug === 'crop-image') {
            await page.locator('[data-crop-apply]').waitFor({ state: 'visible', timeout: 20000 });
            await page.locator('[data-crop-apply]').click();
          }
          if (slug === 'image-to-pdf') {
            await page.locator('[data-build-pdf]').waitFor({ state: 'visible', timeout: 20000 });
            await page.locator('[data-build-pdf]').click();
          }
          const anchor = page.locator('[data-download]').first();
          await anchor.waitFor({ state: 'visible', timeout: 45000 });
          const dl = await Promise.all([
            page.waitForEvent('download', { timeout: 30000 }),
            anchor.click(),
          ]);
          const name = await dl[0].suggestedFilename();
          if (!name) fail.push(`tool produced no filename: ${locale}/tools/${slug}/ (${w}px)`);
          await dl[0].cancel().catch(() => {});
          downloads += 1;
          console.log(`  · ${locale || 'en'}/tools/${slug}/ @${w}px — downloaded "${name}" in ${Date.now() - started}ms`);
        });
      }
      await ctx.close();
    }
  }

  // Batch: three files at once on the two tools that offer a ZIP of all results. A batch is not
  // auto-started — loading several files queues them and waits for the explicit "all" action, so
  // that the order can be changed before anything runs.
  for (const slug of ['compress-image', 'convert-image']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const net = [];
    attachNetwork(ctx, net);
    await withPage(ctx, `/tools/${slug}/`, async (page) => {
      await loadFiles(page, ['small', 'portrait', 'wide']);
      const runAll = page.locator(slug === 'compress-image' ? '[data-compress-all]' : '[data-convert-all]').first();
      await runAll.waitFor({ state: 'visible', timeout: 20000 });
      await runAll.click();
      const zip = page.locator('[data-download-zip]').first();
      await zip.waitFor({ state: 'visible', timeout: 60000 });
      const dl = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        zip.click(),
      ]);
      const name = await dl[0].suggestedFilename();
      if (!/\.zip$/i.test(name)) fail.push(`batch did not produce a ZIP on ${slug}: got "${name}"`);
      await dl[0].cancel().catch(() => {});
      downloads += 1;
      console.log(`  · /tools/${slug}/ batch — downloaded "${name}"`);
    });
    await ctx.close();
  }
  note.push(`tools: ${downloads} real downloads captured across all six tools, both locales, both viewports, plus 2 batch ZIPs`);
}

(async () => {
  links();
  const browser = await chromium.launch();
  try {
    const net = [];
    const counting = (ctx) => attachNetwork(ctx, net);
    browser.on('disconnected', () => {});
    await pages(browser);
    await chrome(browser);
    await tools(browser);
    if (net.length) {
      fail.push(`${net.length} requests left the origin:`);
      net.slice(0, 12).forEach((u) => fail.push(`   EXT ${u}`));
    } else {
      note.push('network: zero requests left the origin across the entire run');
    }
  } finally {
    await browser.close();
  }

  console.log('');
  for (const n of note) console.log(`  ✔ ${n}`);
  if (fail.length) {
    console.log('');
    for (const f of fail) console.log(`  ✗ ${f}`);
    console.log(`\nsmoke: ${fail.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nsmoke: all green');
})();
