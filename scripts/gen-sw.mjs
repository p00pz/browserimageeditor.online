#!/usr/bin/env node
/**
 * dist/sw.js — the service worker, stamped with a version and the file lists it needs.
 *
 * Runs after `vite build`, because everything it knows comes from the built output: which routes
 * exist, what each one references, and how big those files are. It is the same shape as gen-og.mjs
 * and gen-sitemap.mjs — one script owns one artifact — except that its input is `dist/` rather than
 * `content/`, so it cannot run any earlier than the build.
 *
 * What it computes:
 *
 *   1. **The shell.** The homepage, the offline page, the shared CSS and JS they reference, the
 *      manifest, the favicon and the icon set. Precached at install, so the site opens and the
 *      offline page is reachable after a single visit. About 80 KB today, most of it the icons.
 *   2. **A bundle per route.** For each emitted page, the HTML plus — following the *static* import
 *      graph — every chunk and worker script it needs. Dynamic `import(...)` chunks are walked only
 *      when they are under a size cap: the document writer (438 KB) is inside it, because without it
 *      the PDF tool cannot produce anything offline; the HEIC decoder (2.9 MB) is outside it, because
 *      most visitors to that page never touch a HEIC, and it is cached on first use anyway.
 *   3. **A version string.** A hash of every emitted filename plus the shell files' contents. Any
 *      deploy that renames a chunk or edits the shell bumps it, which is what tells the worker to
 *      replace its shell cache; the pages and assets it has already cached survive.
 *
 * The graph walk itself lives in scripts/lib/dist.mjs, so it can be tested against a fixture without
 * a build, and so `audit-pwa.mjs` resolves the same URLs with the same arithmetic.
 *
 * Output:
 *   dist/sw.js
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { loadPages, projectRoot } from './lib/content.mjs';
import { builtFilePath, builtFileSize, bundleForRoute, findBuiltRoutes } from './lib/dist.mjs';
import { APPLE_TOUCH_ICON, ICONS, MANIFEST_PATH } from './lib/pwa.mjs';
import { reportWrites, writeGenerated } from './lib/render.mjs';

const DIST = resolve(projectRoot, 'dist');
const FAVICON = '/favicon.svg';
const TEMPLATE = resolve(projectRoot, 'scripts', 'templates', 'sw.js');

/**
 * The largest dynamic chunk worth warming, in bytes.
 *
 * Measured, not guessed: `vite build` emits exactly two dynamic chunks today — the document writer
 * at 438 KB, which the PDF tool needs before it can do anything, and the HEIC decoder at 2.9 MB,
 * which only a HEIC conversion needs. The cap sits between them, so a tool is usable offline after
 * being visited, while a rarely needed multi-megabyte decoder is never pushed at someone who is just
 * looking at the page. Both are cached when they are actually used, because by then the worker is in
 * control of the page.
 */
const DYNAMIC_WARM_LIMIT = 500 * 1024;

if (!existsSync(DIST)) {
  console.error('gen-sw: dist/ does not exist. Run "npm run build" first.');
  process.exit(1);
}

const fileOf = (url) => builtFilePath(DIST, url);
const sizeOf = (url) => builtFileSize(DIST, url);

/* ---------- the bundles ---------- */

const routes = findBuiltRoutes(DIST).sort();
const bundles = new Map();

for (const route of routes) {
  bundles.set(route, bundleForRoute(DIST, route, { dynamicLimit: DYNAMIC_WARM_LIMIT }));
}

/**
 * The offline fallback is whichever page the content model marks `utility`. Looked up rather than
 * written as a literal, and required to be exactly one: two utility pages would make "the offline
 * page" ambiguous, and none would leave a navigation with nothing to fall back to.
 */
const utilityPages = loadPages().filter((page) => page.status === 'utility');
if (utilityPages.length !== 1) {
  console.error(
    `gen-sw: expected exactly one "utility" page in content/pages.json as the offline fallback, found ${utilityPages.length}.`,
  );
  process.exit(1);
}
const OFFLINE_URL = `/pages/${utilityPages[0].slug}/`;
if (!bundles.has(OFFLINE_URL)) {
  console.error(`gen-sw: the offline page ${OFFLINE_URL} was not built. Run "npm run gen" then "npm run build".`);
  process.exit(1);
}

const shell = [
  ...new Set([
    ...bundles.get('/').files,
    ...bundles.get(OFFLINE_URL).files,
    MANIFEST_PATH,
    FAVICON,
    ...ICONS.map((icon) => icon.path),
    APPLE_TOUCH_ICON.path,
  ]),
].sort();

/**
 * Every shell entry must exist. This is the loud gate — the worker tolerates a missing file at
 * runtime (warn and carry on) precisely because this is where it cannot get past unnoticed.
 */
const missing = shell.filter((url) => sizeOf(url) === null);
if (missing.length > 0) {
  console.error('gen-sw: these shell files are listed but missing from dist/:');
  for (const url of missing) console.error(`  ! ${url}`);
  console.error('gen-sw: refusing to write a service worker that promises files that do not exist.');
  process.exit(1);
}

/* ---------- version ---------- */

function allFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) allFiles(full, files);
    else files.push(relative(DIST, full).split(sep).join('/'));
  }
  return files;
}

/**
 * Filenames catch every renamed chunk; the shell files' contents catch an edit to a file whose name
 * does not change (the offline page's HTML, the manifest). Page HTML other than the shell's is
 * deliberately not hashed: it is served network-first, so a content-only change to it needs no new
 * shell at all.
 */
const hash = createHash('sha256');
for (const file of allFiles(DIST).sort()) {
  // The worker's own file is excluded: hashing it would make the version depend on whether a
  // previous run had already written it, so the first run after a clean build and the second would
  // disagree about the version of identical inputs.
  if (file === 'sw.js') continue;
  hash.update(`${file}\n`);
}
for (const url of shell) hash.update(`${url}:${readFileSync(fileOf(url))}`);
const VERSION = hash.digest('hex').slice(0, 10);

/* ---------- the worker ---------- */

// The route is its own document URL, so only the *asset* half is stored — and that half is identical
// across the guides that share a tool, which is what keeps this file a few kilobytes rather than
// twenty. Six unique sets cover all 26 routes today.
const assetSets = [];
// Parallel to assetSets: the keys are strings, the sets are arrays, and indexOf compares by value.
const assetKeys = [];
const bundleIndex = {};
for (const [route, bundle] of bundles) {
  const assets = bundle.files.filter((url) => url !== route);
  const key = JSON.stringify(assets);
  let index = assetKeys.indexOf(key);
  if (index === -1) {
    index = assetSets.length;
    assetSets.push(assets);
    assetKeys.push(key);
  }
  bundleIndex[route] = index;
}

const template = readFileSync(TEMPLATE, 'utf8');
const sw = template
  .replace('__VERSION__', VERSION)
  .replace('__OFFLINE_URL__', OFFLINE_URL)
  .replace('__SHELL__', JSON.stringify(shell, null, 2))
  .replace('__BUNDLE_INDEX__', JSON.stringify(bundleIndex, null, 2))
  .replace('__ASSET_SETS__', JSON.stringify(assetSets, null, 2));

const leftover = sw.match(/__[A-Z][A-Z_]*__/g);
if (leftover) {
  console.error(`gen-sw: the template still contains ${leftover.join(', ')} — check scripts/templates/sw.js.`);
  process.exit(1);
}

const results = [writeGenerated(resolve(DIST, 'sw.js'), sw)];

/* ---------- what happened ---------- */

const shellBytes = shell.reduce((total, url) => total + sizeOf(url), 0);
const sizes = [...bundles.values()].map((bundle) =>
  bundle.files.reduce((total, url) => total + sizeOf(url), 0),
);
const skipped = new Map();
for (const bundle of bundles.values()) for (const [url, size] of bundle.skipped) skipped.set(url, size);
const ignored = [...bundles.values()].reduce((total, bundle) => total + bundle.ignored, 0);

reportWrites(results, { prefix: `gen-sw (${routes.length} routes, ${assetSets.length} asset sets)` });
console.log(`gen-sw: version ${VERSION}`);
console.log(
  `gen-sw: shell ${(shellBytes / 1024).toFixed(1)} KB over ${shell.length} files — offline fallback ${OFFLINE_URL}`,
);
console.log(
  `gen-sw: warm bundle ${(Math.min(...sizes) / 1024).toFixed(1)}–${(Math.max(...sizes) / 1024).toFixed(1)} KB per route`,
);
for (const [url, size] of skipped) {
  console.log(`gen-sw: not warmed (fetched on first use) ${url} — ${(size / 1024).toFixed(0)} KB`);
}
if (ignored > 0) {
  console.log(`gen-sw: ignored ${ignored} module-like string(s) that are not emitted files`);
}
