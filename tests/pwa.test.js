/**
 * PWA / offline tests.
 *
 * Four things are checked here that nothing else can check:
 *
 *   1. the manifest on disk is *exactly* what content/site.json generates, and it meets Chrome's
 *      published install criteria — 192px and 512px icons that are real PNGs of the size they claim,
 *      `start_url`, a valid `display`, `prefer_related_applications` not true;
 *   2. every generated page carries the install head, across all five page kinds. This is the check
 *      that caught a target page shipped without a manifest link the first time round;
 *   3. the offline fallback exists, is noindex, is in no nav and in no sitemap, and its copy is real
 *      prose rather than a placeholder — the same content gate the target pages get;
 *   4. the build-time graph walk and the generated service worker keep their promises: static
 *      imports are followed, dynamic chunks over the cap are left out, /og/ is never cached, and
 *      every URL the worker lists resolves to a file that exists.
 *
 * The service worker checks need a build (`dist/`), so they skip with a message when there is none.
 * The walk itself is tested against a fixture, so the risky part is covered without one.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPages, loadSite, loadTools, pageFile, publicDir, siteRoutes } from '../scripts/lib/content.mjs';
import { builtFileSize, bundleForRoute, findBuiltRoutes, readPngSize } from '../scripts/lib/dist.mjs';
import {
  APPLE_TOUCH_ICON,
  ICONS,
  MANIFEST_PATH,
  buildManifest,
  composeIconSvg,
  iconPlan,
} from '../scripts/lib/pwa.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(root, 'dist');
const hasDist = existsSync(DIST);
/** Must match the cap in scripts/gen-sw.mjs and the note in scripts/lib/dist.mjs's caller. */
const DYNAMIC_WARM_LIMIT = 500 * 1024;

const site = loadSite();
const tools = loadTools();

function everyRoute() {
  const routes = [];
  for (const locale of site.locales) {
    const { site: localeSite, routes: localeRoutes } = siteRoutes(locale.code);
    for (const route of localeRoutes) {
      routes.push({ ...route, locale: locale.code, site: localeSite, file: pageFile(localeSite, locale.code, route.path) });
    }
  }
  return routes;
}

/** The biggest emitted JS chunk — the one the warm cap exists to leave out. */
function largestJsAsset() {
  let best = { url: '/assets/none.js', size: 0 };
  for (const entry of readdirSync(resolve(DIST, 'assets'))) {
    if (!entry.endsWith('.js')) continue;
    const url = `/assets/${entry}`;
    const size = builtFileSize(DIST, url) ?? 0;
    if (size > best.size) best = { url, size };
  }
  return best;
}

/* ---------- the manifest ---------- */

test('the manifest on disk is exactly what the content model generates', () => {
  const onDisk = JSON.parse(readFileSync(resolve(publicDir, MANIFEST_PATH.replace(/^\//, '')), 'utf8'));
  assert.deepEqual(onDisk, buildManifest(site, tools));
});

test('the manifest meets Chrome install criteria', () => {
  const manifest = JSON.parse(readFileSync(resolve(publicDir, MANIFEST_PATH.replace(/^\//, '')), 'utf8'));

  assert.ok(manifest.name, 'a name is required');
  assert.ok(manifest.short_name, 'a short_name is required');
  assert.ok(manifest.short_name.length <= 12, 'a longer short_name gets truncated on a home screen');
  assert.equal(manifest.start_url, '/');
  assert.ok(
    ['fullscreen', 'standalone', 'minimal-ui', 'window-controls-overlay'].includes(manifest.display),
    `"${manifest.display}" is not a display mode Chrome installs`,
  );
  assert.notEqual(manifest.prefer_related_applications, true);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);

  const sizes = manifest.icons.map((icon) => icon.sizes);
  for (const required of ['192x192', '512x512']) {
    assert.ok(sizes.includes(required), `no ${required} icon`);
  }
  assert.ok(
    manifest.icons.some((icon) => String(icon.purpose).includes('maskable')),
    'a maskable icon is what stops Android cropping the mark into a circle',
  );

  // The colours come from content/site.json, not from the manifest file, so the site and the
  // installed app cannot drift apart.
  assert.equal(manifest.theme_color, site.themeColor);
  assert.equal(manifest.background_color, site.backgroundColor);

  for (const shortcut of manifest.shortcuts ?? []) {
    const tool = tools.find((entry) => `/tools/${entry.slug}/` === shortcut.url);
    assert.ok(tool, `shortcut ${shortcut.url} does not belong to a tool`);
    assert.equal(tool.status, 'live', `shortcut ${shortcut.name} points at a tool that is not live`);
  }
});

test('every icon the manifest declares is a real PNG of the size it claims', () => {
  const manifest = JSON.parse(readFileSync(resolve(publicDir, MANIFEST_PATH.replace(/^\//, '')), 'utf8'));
  const seen = new Set();

  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('/icons/'), `${icon.src} should live under /icons/`);
    assert.ok(!seen.has(icon.src), `${icon.src} is declared twice`);
    seen.add(icon.src);

    const file = resolve(publicDir, icon.src.replace(/^\//, ''));
    assert.ok(existsSync(file), `${icon.src} does not exist`);

    const size = readPngSize(readFileSync(file));
    assert.ok(size, `${icon.src} is not a PNG`);
    assert.equal(`${size.width}x${size.height}`, icon.sizes, `${icon.src} is not ${icon.sizes}`);
  }

  const apple = readPngSize(readFileSync(resolve(publicDir, APPLE_TOUCH_ICON.path.replace(/^\//, ''))));
  assert.equal(`${apple.width}x${apple.height}`, '180x180');
});

test('the four icon variants are composed from one piece of artwork', () => {
  const plan = iconPlan('#0366d6');
  assert.equal(plan.length, ICONS.length + 1, 'one variant per icon file');
  assert.deepEqual(
    plan.map((entry) => entry.icon.path),
    [...ICONS, APPLE_TOUCH_ICON].map((icon) => icon.path),
  );

  const svg = composeIconSvg({ size: 192, glyph: '<rect x="3" y="3" width="18" height="18"/>', background: '#123456', glyphRatio: 0.62, radiusRatio: 0.219 });
  const scale = Number(((192 * 0.62) / 24).toFixed(4));
  const offset = Number(((192 - 24 * scale) / 2).toFixed(4));
  assert.match(svg, new RegExp(`translate\\(${offset} ${offset}\\) scale\\(${scale}\\)`), 'the glyph must be centred');
  assert.match(svg, /fill="#123456"/);
  assert.match(svg, /stroke="#ffffff"/);
  assert.match(svg, /<rect x="3" y="3" width="18" height="18"\/>/, 'the artwork must be embedded');
  assert.match(svg, /rx="42"/, 'the corner radius is a fraction of the canvas');

  // The maskable variant draws a smaller glyph, so Android's crop cannot clip it.
  const plain = composeIconSvg({ size: 512, glyph: '<rect/>', background: '#000000', glyphRatio: 0.62, radiusRatio: 0.219 });
  const maskable = composeIconSvg({ size: 512, glyph: '<rect/>', background: '#000000', glyphRatio: 0.5, radiusRatio: 0 });
  const scaleOf = (markup) => Number(markup.match(/scale\(([\d.]+)\)/)[1]);
  assert.ok(scaleOf(maskable) < scaleOf(plain), 'the maskable glyph must be the smaller one');
  assert.match(maskable, /rx="0"/, 'a maskable icon is full-bleed');
});

/* ---------- every page carries the install head ---------- */

test('every generated page carries the manifest, theme colours and touch icon', () => {
  const routes = everyRoute();
  assert.ok(routes.length >= 25, 'the route inventory should be the whole site');

  for (const route of routes) {
    const html = readFileSync(route.file, 'utf8');
    const links = [...html.matchAll(/<link rel="manifest" href="([^"]*)">/g)].map((match) => match[1]);
    assert.deepEqual(links, [MANIFEST_PATH], `${route.path} must link the manifest exactly once`);

    assert.ok(html.includes(`href="${APPLE_TOUCH_ICON.path}"`), `${route.path} has no apple-touch-icon`);
    assert.ok(html.includes(`content="${route.site.themeColor}"`), `${route.path} has no light theme colour`);
    assert.ok(html.includes(`content="${route.site.themeColorDark}"`), `${route.path} has no dark theme colour`);

    // Only a page that ships may be indexed; only one that does not advertise itself may be noindex.
    const noindex = /name="robots"[^>]*noindex/.test(html);
    if (route.status === 'live') assert.equal(noindex, false, `${route.path} is live but noindex`);
    else assert.equal(noindex, true, `${route.path} is not live and must be noindex`);
  }
});

/* ---------- the offline fallback ---------- */

test('the offline fallback is generated, unadvertised and written in real prose', () => {
  const pages = loadPages();
  const utility = pages.filter((page) => page.status === 'utility');
  assert.equal(utility.length, 1, 'exactly one utility page is the offline fallback');

  const page = utility[0];
  assert.deepEqual(page.nav, [], 'the offline page must not be linked from a nav');
  assert.ok(page.priority <= 0.1, 'the offline page is not a page to advertise');

  const url = `/pages/${page.slug}/`;
  const file = resolve(root, 'src', `pages/${page.slug}/index.html`);
  const html = readFileSync(file, 'utf8');
  assert.match(html, /name="robots" content="noindex/, 'the offline fallback must not be indexable');

  const sitemap = readFileSync(resolve(publicDir, 'sitemap.xml'), 'utf8');
  assert.ok(!sitemap.includes(`${url}<`), 'the offline fallback must not be in the sitemap');

  for (const partial of ['nav-pages.html', 'nav-header-pages.html']) {
    assert.ok(!readFileSync(resolve(root, 'src/partials', partial), 'utf8').includes(url), `${partial} links the offline page`);
  }

  // Real copy, not a placeholder: the same kind of gate the target pages clear.
  const words = html
    .replace(/[\s\S]*?<article[^>]*>/, '')
    .replace(/<\/article>[\s\S]*/, '')
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  assert.ok(words >= 150, `the offline page has only ${words} words of copy`);
});

/* ---------- the build-time graph walk ---------- */

test('the warm bundle follows static imports and skips dynamic chunks over the cap', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'gen-sw-fixture-'));
  try {
    mkdirSync(join(fixture, 'assets'), { recursive: true });
    writeFileSync(join(fixture, 'index.html'), '<script type="module" src="/assets/entry.js"></script>');
    writeFileSync(
      join(fixture, 'assets/entry.js'),
      [
        'import{a}from"./static-one.js";',
        'import"./static-two.js";',
        'import("./lazy-small.js");',
        'import("./lazy-big.js");',
        'import"./missing.js";',
        'new Worker("/assets/compress.worker.js",{type:"module"});',
      ].join('\n'),
    );
    writeFileSync(join(fixture, 'assets/static-one.js'), 'export const a=1;');
    writeFileSync(join(fixture, 'assets/static-two.js'), 'console.log(1);');
    writeFileSync(join(fixture, 'assets/compress.worker.js'), 'self.onmessage=()=>{};');
    writeFileSync(join(fixture, 'assets/lazy-small.js'), 'x'.repeat(1000));
    writeFileSync(join(fixture, 'assets/lazy-big.js'), 'x'.repeat(5000));

    const bundle = bundleForRoute(fixture, '/', { dynamicLimit: 2000 });

    assert.deepEqual(bundle.files, [
      '/',
      '/assets/compress.worker.js',
      '/assets/entry.js',
      '/assets/lazy-small.js',
      '/assets/static-one.js',
      '/assets/static-two.js',
    ]);
    // A worker script reached only through a string literal is still part of what the page needs.
    assert.ok(bundle.files.includes('/assets/compress.worker.js'));
    // Over the cap, and reported rather than silently dropped.
    assert.equal(bundle.skipped.get('/assets/lazy-big.js'), 5000);
    assert.ok(!bundle.files.includes('/assets/lazy-big.js'));
    // A module-like string that is not an emitted file is counted, not promised.
    assert.equal(bundle.ignored, 1);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

/* ---------- the generated service worker ---------- */

test('the generated service worker lists only files the build produced', { skip: hasDist ? false : 'no dist/ — run npm run build' }, () => {
  const source = readFileSync(resolve(DIST, 'sw.js'), 'utf8');
  const shell = JSON.parse(source.match(/const SHELL = (\[[\s\S]*?\n\]);/)[1]);
  const index = JSON.parse(source.match(/const PAGE_BUNDLE_INDEX = (\{[\s\S]*?\n\});/)[1]);
  const sets = JSON.parse(source.match(/const PAGE_ASSET_SETS = (\[[\s\S]*?\n\]);/)[1]);
  const offline = source.match(/const OFFLINE_URL = '([^']+)';/)[1];

  assert.match(source.match(/const VERSION = '([^']+)';/)[1], /^[0-9a-f]{8,}$/, 'the shell version must be a content hash');

  for (const url of shell) {
    assert.ok(builtFileSize(DIST, url) !== null, `${url} is precached but does not exist`);
  }
  for (const required of [MANIFEST_PATH, '/favicon.svg', ...ICONS.map((icon) => icon.path), APPLE_TOUCH_ICON.path, offline]) {
    assert.ok(shell.includes(required), `the shell must include ${required}`);
  }

  const routes = findBuiltRoutes(DIST).sort();
  assert.deepEqual(Object.keys(index).sort(), routes, 'one warm bundle per built route, and no others');
  assert.ok(sets.length < routes.length, 'identical asset sets must be stored once');

  const assets = new Set(sets.flat());
  for (const url of assets) {
    assert.ok(!url.startsWith('/og/'), `${url} is a share image the app never requests`);
    const size = builtFileSize(DIST, url);
    assert.ok(size !== null, `${url} is warmed but does not exist`);
    assert.ok(size <= DYNAMIC_WARM_LIMIT, `${url} is ${size} bytes, over the warm cap`);
  }

  // Every live tool page warms its own worker, or it could not process anything offline.
  for (const tool of tools.filter((entry) => entry.status === 'live')) {
    const set = sets[index[`/tools/${tool.slug}/`]];
    assert.ok(
      set.some((url) => /\.worker-[^/]*\.js$/.test(url)),
      `/tools/${tool.slug}/ does not warm a worker script`,
    );
  }

  // The one chunk deliberately left out: the multi-megabyte decoder is fetched when it is needed.
  const largest = largestJsAsset();
  assert.ok(largest.size > DYNAMIC_WARM_LIMIT, 'this test assumes a chunk above the cap exists');
  assert.ok(!assets.has(largest.url), `the largest chunk (${largest.url}, ${largest.size} bytes) must not be warmed`);
});

/**
 * The regression this test exists for: the first end-to-end offline check looked like a success and
 * was not. The cached document rendered, and all eight of its chunks failed with net::ERR_FAILED, so
 * the site came back with no CSS and no JavaScript.
 *
 * The cause is `Vary`. Cache Storage only matches a stored response against a request whose varying
 * headers agree with the request that stored it. The warm-up stores with a plain `fetch(url)`, which
 * sends no `Origin`; every subresource these pages load is CORS-mode — Vite marks its scripts,
 * modulepreloads and stylesheets `crossorigin` — and a CORS-mode request does send one. Any host
 * setting `Vary: Origin` (Vite's dev and preview servers do, through their default `cors: true`)
 * turns every offline subresource into a cache miss.
 *
 * Structural rather than behavioural, and it has to be: the policy lives in a service worker, which
 * no test in this suite can execute. It fails loudly the moment someone adds a lookup without MATCH.
 */
test('every cache lookup in the generated worker ignores Vary', { skip: hasDist ? false : 'no dist/ — run npm run build' }, () => {
  const source = readFileSync(resolve(DIST, 'sw.js'), 'utf8');
  assert.match(source, /const MATCH = \{ ignoreVary: true \};/, 'the shared match options must exist');

  const lookups = [...source.matchAll(/\.match\(([^)]*)\)/g)].map((match) => match[1]);
  assert.ok(lookups.length >= 5, `expected every lookup to be checked, found ${lookups.length}`);
  for (const args of lookups) {
    assert.match(args, /MATCH|ignoreVary: true/, `this lookup still honours Vary, which breaks offline: ${args}`);
  }
});

test('the PWA audit itself exits clean, and fails when the worker is missing', { skip: hasDist ? false : 'no dist/ — run npm run build' }, () => {
  const output = execFileSync(process.execPath, ['scripts/audit-pwa.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /audit-pwa: 0 errors/, `the audit found errors:\n${output}`);

  // It must not be a script that always passes.
  const target = resolve(DIST, 'sw.js');
  const moved = `${target}.audit-probe`;
  renameSync(target, moved);
  try {
    assert.throws(
      () => execFileSync(process.execPath, ['scripts/audit-pwa.mjs'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }),
      (error) => {
        const text = String(error.stdout ?? '');
        assert.match(text, /does not exist/, 'the audit must say what is wrong');
        return true;
      },
    );
  } finally {
    renameSync(moved, target);
  }
});
