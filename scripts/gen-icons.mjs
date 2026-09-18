#!/usr/bin/env node
/**
 * App icons: the PNG set that public/manifest.webmanifest declares and every page's head links.
 *
 * Four files, all composed from one piece of artwork (`scripts/assets/brand-icon.svg`, a 24x24
 * outline of the mark) and rasterised with `@resvg/resvg-js`, the same tool `gen-og.mjs` already
 * uses. It is a devDependency (MPL-2.0), never imported under `src/` and never shipped.
 *
 * Why generate rather than hand-export: the alternative is three or four PNGs exported once by hand,
 * which stop matching the moment the mark changes and cannot be checked by a test. The geometry lives
 * in scripts/lib/pwa.mjs as pure functions, so `tests/pwa.test.js` can assert the composed SVG and
 * `scripts/audit-pwa.mjs` can assert that the files the manifest promises are real PNGs of the size
 * it claims. This script is only the IO around that.
 *
 * Output:
 *   public/icons/icon-192.png, icon-512.png, icon-512-maskable.png, apple-touch-icon-180.png
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSite, projectRoot, publicDir } from './lib/content.mjs';
import { composeIconSvg, iconPlan } from './lib/pwa.mjs';
import { reportWrites, writeGeneratedBinary } from './lib/render.mjs';

const GLYPH_FILE = resolve(projectRoot, 'scripts', 'assets', 'brand-icon.svg');

/**
 * The white outline, lifted out of the artwork file so the composing code stays about geometry.
 * Fails loudly rather than producing an empty icon: a silently blank PNG is the kind of thing nobody
 * notices until it is on someone's home screen.
 */
function readGlyph(file = GLYPH_FILE) {
  if (!existsSync(file)) throw new Error(`gen-icons: missing artwork at ${file}`);
  const svg = readFileSync(file, 'utf8');
  const inner = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)?.[1]?.trim();
  if (!inner || !inner.includes('<')) {
    throw new Error(`gen-icons: ${file} has no drawing inside its <svg> element`);
  }
  return inner;
}

async function optionalImport(name) {
  try {
    return await import(name);
  } catch {
    return null;
  }
}

const site = loadSite();
const glyph = readGlyph();
// The brand colour for the background, so an installed icon is the same blue the site already uses.
const plan = iconPlan(site.themeColor);
const results = [];

const resvg = await optionalImport('@resvg/resvg-js');

if (!resvg) {
  console.warn('gen-icons: @resvg/resvg-js is not installed, so no icons were written.');
  console.warn('gen-icons: run "npm install && npm run gen:icons". Until then every icon URL in the');
  console.warn('gen-icons: manifest 404s and "npm run audit:pwa" fails on purpose, so it cannot ship unseen.');
} else {
  for (const { icon, variant } of plan) {
    const svg = composeIconSvg({ ...variant, glyph });
    const png = new resvg.Resvg(svg, { fitTo: { mode: 'width', value: variant.size } }).render().asPng();
    results.push(writeGeneratedBinary(resolve(publicDir, icon.path.replace(/^\//, '')), Buffer.from(png)));
  }
}

reportWrites(results, { prefix: `gen-icons (${plan.length} icons)` });
