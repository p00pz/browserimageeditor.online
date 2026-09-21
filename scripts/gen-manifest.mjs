#!/usr/bin/env node
/**
 * public/manifest.webmanifest — the install metadata browsers read.
 *
 * Generated for the same reason public/robots.txt is: the parts of a manifest that must not drift
 * (the app's name, its description, the theme colours, the icon list) already live in
 * content/site.json and scripts/lib/pwa.mjs. Typing them again into a hand-maintained manifest
 * would make a second source of truth for the site's own name, which is exactly what the content
 * layer exists to prevent.
 *
 * No provenance banner in the file itself, unlike the HTML and XML artifacts: JSON has no comments,
 * and a fake member such as `"$generated"` would be a key browsers ignore and humans misread. The
 * header here and `scripts/audit-pwa.mjs` are where that is recorded instead.
 *
 * Output:
 *   public/manifest.webmanifest
 */
import { resolve } from 'node:path';
import { loadSite, loadTools, publicDir } from './lib/content.mjs';
import { MANIFEST_PATH, manifestJson } from './lib/pwa.mjs';
import { reportWrites, writeGenerated } from './lib/render.mjs';

const site = loadSite();
// Shortcuts point at the tools that actually exist, so a planned tool is never promised one.
const tools = loadTools();

const results = [
  writeGenerated(resolve(publicDir, MANIFEST_PATH.replace(/^\//, '')), manifestJson(site, tools)),
];

reportWrites(results, { prefix: 'gen-manifest' });
