#!/usr/bin/env node
/**
 * Copies the self-hosted body and UI face into `public/fonts/`.
 *
 * **Which family, and why this one.** IBM Plex Sans Arabic, SIL Open Font License 1.1. The redesign
 * was drawn for Thmanyah, whose licence forbids hosting the files, subsetting, and derivative works
 * — all three of which an open-source repo and its public build would do — so it is not, and cannot
 * be, the shipped face. IBM Plex Sans Arabic is the closest OFL alternative that covers both the
 * Latin and the Arabic repertoire the site needs, and redistribution is expressly permitted.
 *
 * **Why this is a generator and not a committed directory.** The woff2 files are third-party,
 * unmodified, and byte-for-byte reproducible from a version pinned in package.json — the same
 * argument that keeps `node_modules` and `public/ort/` out of git. The fontsource package ships
 * ready-made per-subset woff2, so nothing here subsets or re-encodes anything: the files are copied
 * as published. `public/fonts/` is generated, `.gitignore`d, and rebuilt on every `dev` and `build`.
 *
 * **Which files.** Two weights only — 400 for body, 600 for the display cut and for emphasis — and
 * two subsets only: `arabic` and `latin`. Cyrillic and Latin-Extended subsets exist upstream but are
 * dead weight for this site's two languages, so they are not copied and never requested.
 *
 * **Why a manifest.** `unicode.json` upstream is the authority for the `unicode-range` values written
 * into the `@font-face` block in `src/assets/css/base.css`. If upstream renames a range, the hash
 * table below stops matching and this script fails loudly instead of quietly shipping a face that
 * cannot render half the alphabet.
 *
 * Output: `public/fonts/` plus a manifest recording the exact upstream version, byte counts and
 * hashes.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

import { projectRoot } from './lib/content.mjs';

const BY = 'scripts/gen-fonts.mjs';
const PACKAGE = '@fontsource/ibm-plex-sans-arabic';
const SRC = resolve(projectRoot, 'node_modules', PACKAGE);
const FILES = resolve(SRC, 'files');
const OUT_DIR = resolve(projectRoot, 'public', 'fonts');
const MANIFEST = resolve(OUT_DIR, 'manifest.json');

const WEIGHTS = [400, 600];
const SUBSETS = ['arabic', 'latin'];

const packageJsonPath = resolve(SRC, 'package.json');
if (!existsSync(packageJsonPath)) {
  console.error(`${BY}: ${PACKAGE} is not installed.`);
  console.error(`${BY}: run \`npm install\` (or \`bun install\`) first — the version in package.json is what gets copied.`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

const ranges = JSON.parse(readFileSync(resolve(SRC, 'unicode.json'), 'utf8'));
for (const subset of SUBSETS) {
  if (!ranges[subset]) {
    console.error(`${BY}: ${PACKAGE}@${version} has no \`${subset}\` range in unicode.json.`);
    console.error(`${BY}: upstream renamed the subset; update SUBSETS and the @font-face block together.`);
    process.exit(1);
  }
}

mkdirSync(OUT_DIR, { recursive: true });

const recorded = [];
let changed = 0;

for (const weight of WEIGHTS) {
  for (const subset of SUBSETS) {
    const from = resolve(FILES, `${PACKAGE.replace('@fontsource/', '')}-${subset}-${weight}-normal.woff2`);
    if (!existsSync(from)) {
      console.error(`${BY}: ${PACKAGE}@${version} has no files/${basename(from)}.`);
      console.error(`${BY}: the woff2 file names changed upstream; update this script and base.css together.`);
      process.exit(1);
    }
    const to = resolve(OUT_DIR, basename(from));
    const bytes = readFileSync(from);
    if (!existsSync(to) || statSync(to).size !== bytes.byteLength) {
      copyFileSync(from, to);
      changed += 1;
    }
    recorded.push({
      name: basename(from),
      subset,
      weight,
      unicodeRange: ranges[subset],
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
}

const licenseFrom = resolve(SRC, 'LICENSE');
const licenseTo = resolve(OUT_DIR, 'OFL.txt');
if (!existsSync(licenseFrom)) {
  console.error(`${BY}: ${PACKAGE}@${version} ships no LICENSE.`);
  console.error(`${BY}: the SIL Open Font License must travel with the font files; do not ship without it.`);
  process.exit(1);
}
if (!existsSync(licenseTo) || readFileSync(licenseTo, 'utf8') !== readFileSync(licenseFrom, 'utf8')) {
  copyFileSync(licenseFrom, licenseTo);
  changed += 1;
}

const manifest = {
  generatedBy: BY,
  package: PACKAGE,
  version,
  family: 'IBM Plex Sans Arabic',
  licence: 'SIL Open Font License, Version 1.1',
  comment: 'Generated from the pinned dev dependency. Do not edit; run `npm run gen:fonts`.',
  note: 'Unmodified upstream woff2 as published. Copied, never subset or re-encoded.',
  files: recorded,
};
const serialised = `${JSON.stringify(manifest, null, 2)}\n`;

const previous = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : null;
if (previous !== serialised) {
  writeFileSync(MANIFEST, serialised);
  changed += 1;
}

const total = recorded.reduce((sum, file) => sum + file.bytes, 0);
const size = `${(total / 1024).toFixed(1)} KB over ${recorded.length} files`;

if (changed === 0) {
  console.log(`gen-fonts: up to date (${PACKAGE}@${version}, ${size})`);
} else {
  console.log(`gen-fonts (${PACKAGE}@${version}): wrote ${changed} file(s)`);
  for (const file of recorded) console.log(`  + public/fonts/${file.name} — ${(file.bytes / 1024).toFixed(1)} KB (${file.subset} ${file.weight})`);
  console.log(`gen-fonts: ${size} + OFL.txt served from /fonts/, fetched from this origin and never a CDN`);
}
