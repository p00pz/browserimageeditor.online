#!/usr/bin/env node
/**
 * Copies the onnxruntime-web runtime a browser actually needs into `public/ort/`.
 *
 * **Why this is a generator and not a committed directory.** The wasm binary is 14.2 MB. It is
 * third-party, unmodified, and reproducible from a version pinned in package.json — the same
 * argument that keeps `node_modules` out of git. So `public/ort/` is generated, `.gitignore`d, and
 * rebuilt on every `dev` and `build`. The alternative, committing it, would put 14 MB of binary in
 * the history for no gain beyond saving one command.
 *
 * **Why serve it ourselves at all.** Left alone, onnxruntime-web resolves its own runtime files from
 * a public CDN. That would be a third-party request from every visitor's browser on a site whose
 * entire promise is that nothing leaves the device, so `core/onnx.js` points `wasmPaths` at `/ort/`
 * and this script guarantees the files are there.
 *
 * **Which build.** The plain SIMD build, `ort-wasm-simd-threaded.{mjs,wasm}`. The `.jsep` variant
 * (WebGPU, 28 MB) and the `.asyncify`/`.jspi` variants (16–27 MB) are for execution providers this
 * project does not use: inference runs on the wasm CPU provider, single-threaded, deliberately, so
 * that nothing here needs SharedArrayBuffer or the COOP/COEP headers that come with it.
 *
 * Output: `public/ort/` plus a manifest recording the exact upstream version, byte counts and
 * hashes, so `tests/models.test.js` can prove the directory matches the pinned dependency.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { projectRoot } from './lib/content.mjs';

const BY = 'scripts/gen-ort.mjs';
const PACKAGE = 'onnxruntime-web';
const DIST = resolve(projectRoot, 'node_modules', PACKAGE, 'dist');
const OUT_DIR = resolve(projectRoot, 'public', 'ort');
const MANIFEST = resolve(OUT_DIR, 'manifest.json');

/** The files the wasm CPU provider loads at runtime, and nothing else. */
const RUNTIME_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

const packageJsonPath = resolve(projectRoot, 'node_modules', PACKAGE, 'package.json');
if (!existsSync(packageJsonPath)) {
  console.error(`${BY}: ${PACKAGE} is not installed.`);
  console.error(`${BY}: run \`npm install\` (or \`bun install\`) first — the version in package.json is what gets copied.`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
mkdirSync(OUT_DIR, { recursive: true });

const recorded = [];
let changed = 0;

for (const name of RUNTIME_FILES) {
  const from = resolve(DIST, name);
  if (!existsSync(from)) {
    console.error(`${BY}: ${PACKAGE}@${version} does not contain dist/${name}.`);
    console.error(`${BY}: the runtime file names changed upstream; update RUNTIME_FILES and core/onnx.js together.`);
    process.exit(1);
  }
  const to = resolve(OUT_DIR, name);
  const bytes = readFileSync(from);
  if (!existsSync(to) || statSync(to).size !== bytes.byteLength) {
    copyFileSync(from, to);
    changed += 1;
  }
  recorded.push({
    name,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

const manifest = {
  generatedBy: BY,
  package: PACKAGE,
  version,
  comment: 'Generated from the pinned dependency. Do not edit; run `npm run gen:ort`.',
  files: recorded,
};
const serialised = `${JSON.stringify(manifest, null, 2)}\n`;

const previous = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : null;
if (previous !== serialised) {
  writeFileSync(MANIFEST, serialised);
  changed += 1;
}

const total = recorded.reduce((sum, file) => sum + file.bytes, 0);
const size = `${(total / 1048576).toFixed(1)} MB over ${recorded.length} files`;

if (changed === 0) {
  console.log(`gen-ort: up to date (${PACKAGE}@${version}, ${size})`);
} else {
  console.log(`gen-ort (${PACKAGE}@${version}): wrote ${changed} file(s)`);
  for (const file of recorded) console.log(`  + public/ort/${file.name} — ${(file.bytes / 1048576).toFixed(2)} MB`);
  console.log(`gen-ort: ${size} served from /ort/, fetched from this origin and never a CDN`);
}
