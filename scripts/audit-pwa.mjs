#!/usr/bin/env node
/**
 * Post-build audit of everything install and offline related, run against `dist/`.
 *
 * Why this exists at all: **Lighthouse no longer has a PWA category.** It was removed in Lighthouse
 * 12.0.0 (Chrome 126) with the note that, per Chrome's updated installability criteria, users should
 * follow the PWA documentation instead. So there is no score to chase, and the honest replacement is
 * a script that checks the criteria as published —
 *
 *   https://web.dev/articles/install-criteria
 *
 * plus the promises this repository makes that no external tool knows about: that every precache URL
 * the service worker lists resolves to a real file, that no four-megabyte share image can end up in
 * a visitor's cache, and that the offline page is reachable but not indexable.
 *
 * It cannot check the two things that need a browser — that the worker actually activates, and that
 * a page loads with the network switched off. qa/strike-proof.mjs covers those against a build.
 *
 * Exit code is 1 when any error is found, so `npm run audit:pwa` can gate a deploy. Warnings do not
 * fail the build unless `--strict` is passed.
 *
 * Usage:
 *   node scripts/audit-pwa.mjs [--strict]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadPages, projectRoot } from './lib/content.mjs';
import { builtFilePath, builtFileSize, findBuiltRoutes, readPngSize } from './lib/dist.mjs';
import { APPLE_TOUCH_ICON, ICONS, MANIFEST_PATH, SERVICE_WORKER_PATH } from './lib/pwa.mjs';

const strict = process.argv.slice(2).includes('--strict');
const DIST = resolve(projectRoot, 'dist');

/** Chrome's own list of display values it will install with. */
const DISPLAY_MODES = ['fullscreen', 'standalone', 'minimal-ui', 'window-controls-overlay'];
/** The shell measures about 80 KB today, most of it the icon set. A megabyte in there is wrong. */
const SHELL_TOTAL_LIMIT = 300 * 1024;
const SHELL_ENTRY_LIMIT = 200 * 1024;
/** Above this, a file is a lazy feature rather than part of a page's bundle. */
const BUNDLE_LAZY_LIMIT = 500 * 1024;

const problems = [];
const error = (file, message) => problems.push({ level: 'error', file, message });
const warn = (file, message) => problems.push({ level: 'warning', file, message });

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (parseError) {
    error(file, `could not be read as JSON (${parseError.message})`);
    return null;
  }
}

/**
 * Pulls the argument of `const NAME = <json>;` out of a generated module.
 *
 * A bracket-counting scan rather than a regex, because the arrays are pretty-printed over many lines
 * and a greedy pattern would happily swallow the rest of the file.
 */
function jsonAfter(source, marker) {
  const at = source.indexOf(marker);
  if (at === -1) return null;
  let index = at + marker.length;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  const open = source[index];
  if (open !== '[' && open !== '{') return null;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let position = index; position < source.length; position += 1) {
    const character = source[position];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(index, position + 1));
    }
  }
  return null;
}

if (!existsSync(DIST)) {
  console.error('audit-pwa: dist/ does not exist. Run "npm run build" first.');
  process.exit(1);
}

const kebab = (size) => `${size}x${size}`;

/* ---------- the manifest ---------- */

const manifestFile = resolve(DIST, MANIFEST_PATH.replace(/^\//, ''));
const manifest = existsSync(manifestFile) ? readJson(manifestFile) : null;
if (!manifest) {
  error('dist/manifest.webmanifest', 'does not exist — the site cannot be installed without it');
}

if (manifest) {
  if (!manifest.name) error('dist/manifest.webmanifest', 'has no "name"');
  if (!manifest.short_name) error('dist/manifest.webmanifest', 'has no "short_name"');
  else if (manifest.short_name.length > 12) {
    warn('dist/manifest.webmanifest', `"short_name" is ${manifest.short_name.length} characters; Chrome truncates past 12`);
  }
  if (!manifest.description) warn('dist/manifest.webmanifest', 'has no "description"');
  if (manifest.start_url !== '/') error('dist/manifest.webmanifest', `"start_url" is "${manifest.start_url}" rather than "/"`);
  if (!DISPLAY_MODES.includes(manifest.display)) {
    error('dist/manifest.webmanifest', `"display" is "${manifest.display}", which Chrome will not install as an app`);
  }
  if (manifest.prefer_related_applications === true) {
    error('dist/manifest.webmanifest', '"prefer_related_applications" is true, so Chrome would not offer the install');
  }
  for (const field of ['theme_color', 'background_color']) {
    if (!/^#[0-9a-fA-F]{6}$/.test(manifest[field] ?? '')) {
      error('dist/manifest.webmanifest', `"${field}" is not a six-digit hex colour`);
    }
  }

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  if (icons.length === 0) error('dist/manifest.webmanifest', 'declares no icons');

  const declared = new Set(icons.map((icon) => icon.sizes));
  for (const size of [192, 512]) {
    if (!declared.has(kebab(size))) {
      error('dist/manifest.webmanifest', `has no ${kebab(size)} icon, which Chrome's install criteria require`);
    }
  }
  if (!icons.some((icon) => String(icon.purpose ?? '').includes('maskable'))) {
    warn('dist/manifest.webmanifest', 'has no maskable icon, so Android will crop the plain one into a circle');
  }

  for (const icon of icons) {
    const url = icon.src;
    const size = builtFileSize(DIST, url);
    if (size === null) {
      error('dist/manifest.webmanifest', `lists ${url}, which does not exist in dist/`);
      continue;
    }
    if (icon.type !== 'image/png') {
      warn('dist/manifest.webmanifest', `declares ${url} as "${icon.type}"`);
    }
    const bytes = readFileSync(builtFilePath(DIST, url));
    const actual = readPngSize(bytes);
    if (!actual) {
      error(`${url}`, 'is not a PNG (no IHDR chunk), so no browser will accept it as an icon');
      continue;
    }
    if (`${actual.width}x${actual.height}` !== icon.sizes) {
      error(`${url}`, `is ${actual.width}x${actual.height} but the manifest declares "${icon.sizes}"`);
    }
  }

  for (const shortcut of manifest.shortcuts ?? []) {
    if (!existsSync(builtFilePath(DIST, shortcut.url))) {
      error('dist/manifest.webmanifest', `shortcut "${shortcut.name}" points at ${shortcut.url}, which is not a built page`);
    }
  }
}

/* ---------- the head of every page ---------- */

const routes = findBuiltRoutes(DIST).sort();
const offlinePages = loadPages().filter((page) => page.status === 'utility');
const offlineUrl = offlinePages.length === 1 ? `/pages/${offlinePages[0].slug}/` : null;

for (const route of routes) {
  const file = builtFilePath(DIST, route);
  const html = readFileSync(file, 'utf8');
  const shown = route === '/' ? 'dist/index.html' : `dist${route}index.html`;

  const manifestLinks = [...html.matchAll(/<link rel="manifest" href="([^"]*)">/g)].map((match) => match[1]);
  if (manifestLinks.length !== 1) {
    error(shown, `has ${manifestLinks.length} manifest links, expected exactly 1`);
  } else if (manifestLinks[0] !== MANIFEST_PATH) {
    error(shown, `links the manifest as "${manifestLinks[0]}" rather than "${MANIFEST_PATH}"`);
  }
  if (!/name="theme-color"/.test(html)) error(shown, 'has no theme-color meta tag');
  if (!html.includes(`href="${APPLE_TOUCH_ICON.path}"`)) {
    error(shown, 'has no apple-touch-icon link, so iOS would install it without an icon');
  }
}

/* ---------- the offline page ---------- */

const sitemapPath = resolve(DIST, 'sitemap.xml');
const sitemap = existsSync(sitemapPath) ? readFileSync(sitemapPath, 'utf8') : '';

if (!offlineUrl) {
  error('content/pages.json', 'has no page with status "utility", so there is no offline fallback to audit');
} else if (!existsSync(builtFilePath(DIST, offlineUrl))) {
  error(`dist${offlineUrl}index.html`, 'is the offline fallback but was not built');
} else {
  const html = readFileSync(builtFilePath(DIST, offlineUrl), 'utf8');
  if (!/name="robots"[^>]*noindex/.test(html)) {
    error(`dist${offlineUrl}index.html`, 'is not noindex, so a fallback page could be indexed as content');
  }
  if (sitemap.includes(`${offlineUrl}<`)) {
    error('dist/sitemap.xml', `lists the offline fallback ${offlineUrl}, which is not a page to advertise`);
  }
}

/* ---------- the service worker ---------- */

const swFile = resolve(DIST, SERVICE_WORKER_PATH.replace(/^\//, ''));
if (!existsSync(swFile)) {
  error('dist/sw.js', 'does not exist — run "npm run gen:sw" after the build');
} else {
  const source = readFileSync(swFile, 'utf8');
  const version = source.match(/const VERSION = '([0-9a-f]{6,})';/)?.[1] ?? null;
  if (!version) error('dist/sw.js', 'has no version constant, so a deploy could never replace the shell');
  if (source.includes('__')) warn('dist/sw.js', 'still contains a template placeholder');

  // Every lookup must ignore Vary, and this is a build gate rather than a style rule. Cache Storage
  // only matches a stored response against a request whose varying headers agree with the request
  // that stored it; the warm-up stores with a plain fetch, which sends no Origin, while every
  // subresource these pages load is CORS-mode and does send one. On any host setting `Vary: Origin`
  // (Vite's dev and preview servers do) each of those becomes a cache miss, and the offline page
  // comes back with no CSS and no JavaScript. The header of scripts/templates/sw.js has the full
  // account of the failure this prevents.
  const lookups = [...source.matchAll(/\.match\(([^)]*)\)/g)].map((match) => match[1]);
  if (lookups.length === 0) {
    error('dist/sw.js', 'has no cache lookups at all, so nothing could be served offline');
  }
  for (const args of lookups) {
    if (!/MATCH|ignoreVary: true/.test(args)) {
      error('dist/sw.js', `honours Vary in a cache lookup (${args}), which breaks offline on a CORS-enabled host`);
    }
  }

  const shell = jsonAfter(source, 'const SHELL = ');
  const bundleIndex = jsonAfter(source, 'const PAGE_BUNDLE_INDEX = ');
  const bundles = jsonAfter(source, 'const PAGE_ASSET_SETS = ');
  const offlineMatch = source.match(/const OFFLINE_URL = '([^']+)';/)?.[1] ?? null;

  if (!Array.isArray(shell) || !bundleIndex || !Array.isArray(bundles) || !offlineMatch) {
    error('dist/sw.js', 'does not declare the shell, bundles and offline URL it is supposed to carry');
  } else {
    if (!shell.includes(offlineMatch)) {
      error('dist/sw.js', `does not precache the offline fallback ${offlineMatch}`);
    }
    for (const required of [MANIFEST_PATH, '/favicon.svg', ...ICONS.map((icon) => icon.path), APPLE_TOUCH_ICON.path]) {
      if (!shell.includes(required)) error('dist/sw.js', `does not precache ${required}`);
    }

    let shellBytes = 0;
    for (const url of shell) {
      const size = builtFileSize(DIST, url);
      if (size === null) {
        error('dist/sw.js', `precaches ${url}, which does not exist in dist/`);
        continue;
      }
      shellBytes += size;
      if (size > SHELL_ENTRY_LIMIT) {
        error('dist/sw.js', `precaches ${url} at ${(size / 1024).toFixed(0)} KB, which is not app shell`);
      }
    }
    if (shellBytes > SHELL_TOTAL_LIMIT) {
      error('dist/sw.js', `precaches ${(shellBytes / 1024).toFixed(0)} KB of shell, over the ${SHELL_TOTAL_LIMIT / 1024} KB budget`);
    }

    const covered = Object.keys(bundleIndex);
    for (const route of routes) {
      if (!(route in bundleIndex)) error('dist/sw.js', `has no warm bundle for ${route}`);
    }
    for (const route of covered) {
      if (!routes.includes(route)) error('dist/sw.js', `has a warm bundle for ${route}, which is not a built page`);
    }
    for (const index of Object.values(bundleIndex)) {
      if (!Number.isInteger(index) || index < 0 || index >= bundles.length) {
        error('dist/sw.js', `points a route at asset set ${index}, which does not exist`);
      }
    }

    const seen = new Set();
    for (const bundle of bundles) {
      for (const url of bundle) {
        if (seen.has(url)) continue;
        seen.add(url);
        if (url.startsWith('/og/')) {
          error('dist/sw.js', `would cache ${url}, a share image the app never requests`);
        }
        if (builtFileSize(DIST, url) === null) {
          error('dist/sw.js', `warms ${url}, which does not exist in dist/`);
        }
      }
    }
    for (const bundle of bundles) {
      const bytes = bundle.reduce((total, url) => total + (builtFileSize(DIST, url) ?? 0), 0);
      if (bytes > BUNDLE_LAZY_LIMIT + SHELL_ENTRY_LIMIT) {
        warn('dist/sw.js', `a warm bundle totals ${(bytes / 1024).toFixed(0)} KB`);
      }
    }

    console.log(
      `audit-pwa: version ${version}, shell ${(shellBytes / 1024).toFixed(1)} KB over ${shell.length} files, ` +
        `${bundles.length} bundles for ${covered.length} routes`,
    );
  }
}

/* ---------- registration is in the shipped bundle ---------- */

const assetsDir = resolve(DIST, 'assets');
let registers = false;
if (existsSync(assetsDir)) {
  for (const entry of readdirSync(assetsDir)) {
    if (!entry.endsWith('.js')) continue;
    const text = readFileSync(resolve(assetsDir, entry), 'utf8');
    if (text.includes(SERVICE_WORKER_PATH) && text.includes('serviceWorker')) registers = true;
  }
}
if (!registers) {
  error('dist/assets', `no built script registers ${SERVICE_WORKER_PATH}, so nothing would ever go offline`);
}

/* ---------- report ---------- */

const errors = problems.filter((problem) => problem.level === 'error');
const warnings = problems.filter((problem) => problem.level === 'warning');

for (const problem of [...errors, ...warnings]) {
  console.log(`  ${problem.level === 'error' ? 'ERR ' : 'warn'} ${problem.file}: ${problem.message}`);
}

console.log(
  `audit-pwa: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
);
if (errors.length === 0 && warnings.length > 0 && !strict) {
  console.log('audit-pwa: warnings do not fail the build. Pass --strict to treat them as errors.');
}
if (errors.length > 0 || (strict && warnings.length > 0)) process.exit(1);
