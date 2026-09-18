/**
 * Reading the built site.
 *
 * `gen-sw.mjs` and `audit-pwa.mjs` both need to walk `dist/` and map a precache URL back to the file
 * it points at. They must agree about that mapping exactly, because the generator's job is to write
 * URLs into a service worker and the audit's job is to prove those URLs resolve — two independent
 * copies of the same path arithmetic would make the audit agree with itself rather than with the
 * build.
 *
 * Everything here takes the dist directory as an argument rather than resolving it, so a test can
 * point it at a fixture.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

/** URL of a built page, e.g. `dist/tools/compress-image/index.html` -> `/tools/compress-image/`. */
export function routeOf(distDir, directory) {
  const rel = relative(distDir, directory).split(sep).join('/');
  return rel === '' ? '/' : `/${rel}/`;
}

/** Every page route in a build. */
export function findBuiltRoutes(distDir, dir = distDir, routes = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) findBuiltRoutes(distDir, full, routes);
    else if (entry.name === 'index.html') routes.push(routeOf(distDir, dir));
  }
  return routes;
}

/** The file on disk a URL points at. A route ends in a slash and maps to its index.html. */
export function builtFilePath(distDir, url) {
  if (url === '/') return resolve(distDir, 'index.html');
  if (url.endsWith('/')) return resolve(distDir, url.replace(/^\//, ''), 'index.html');
  return resolve(distDir, url.replace(/^\//, ''));
}

/** Byte length of a built file, or null when there is no such file. */
export function builtFileSize(distDir, url) {
  const file = builtFilePath(distDir, url);
  if (!existsSync(file)) return null;
  try {
    const stats = statSync(file);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

/* ---------- the module graph of a built page ---------- */

const DYNAMIC_IMPORT = /import\s*\(\s*(["'])([^"']+)\1\s*\)/g;
/** Module-like strings: an /assets/ path or a relative one, ending in .js or .css. */
const MODULE_SPEC = /(["'])((?:\/assets\/|\.{1,2}\/)[^"']+\.(?:js|css))\1/g;

/** The `/assets/...` URLs a built page's HTML loads. */
export function assetRefsInHtml(html) {
  const refs = [];
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) refs.push(match[1]);
  return refs;
}

/** Resolves a relative specifier against the URL of the file that contains it. */
export function resolveSpec(spec, fromUrl) {
  if (spec.startsWith('/')) return spec;
  const base = fromUrl.slice(0, fromUrl.lastIndexOf('/') + 1);
  return new URL(spec, `https://spec.invalid${base}`).pathname;
}

/**
 * Module references in a JS chunk, split by kind.
 *
 * Dynamic imports are masked out before the static ones are read, because `import("./x.js")` and
 * `import"./x.js"` differ only by parentheses and mean very different things: one is a chunk fetched
 * when a feature is used, the other is code the page cannot run without. That distinction is the
 * whole reason this function exists rather than one regex.
 */
export function refsInJs(text, fromUrl) {
  const dynamic = [];
  const masked = text.replace(DYNAMIC_IMPORT, (match, quote, spec) => {
    dynamic.push(resolveSpec(spec, fromUrl));
    return 'import(__DYNAMIC__)';
  });
  const statics = [];
  for (const match of masked.matchAll(MODULE_SPEC)) statics.push(resolveSpec(match[2], fromUrl));
  return { statics, dynamic };
}

/**
 * Everything one built page cannot run without: its own HTML, then transitive *static* references.
 *
 * A dynamic chunk is walked only when it is under `dynamicLimit`, so a deliberately excluded one is
 * never even read. A string that resolves to no emitted file is dropped and counted, so a false
 * positive in a chunk's text cannot make a caller promise a file that does not exist.
 */
export function bundleForRoute(distDir, route, { dynamicLimit = Infinity, readFile = (file) => readFileSync(file, 'utf8') } = {}) {
  const files = new Set([route]);
  const skipped = new Map();
  let ignored = 0;
  const queue = assetRefsInHtml(readFile(builtFilePath(distDir, route)));

  while (queue.length > 0) {
    const url = queue.shift();
    if (files.has(url)) continue;
    const size = builtFileSize(distDir, url);
    if (size === null) {
      ignored += 1;
      continue;
    }
    files.add(url);
    if (!url.endsWith('.js')) continue;

    const { statics, dynamic } = refsInJs(readFile(builtFilePath(distDir, url)), url);
    queue.push(...statics);
    for (const spec of dynamic) {
      if (files.has(spec) || skipped.has(spec)) continue;
      const dynamicSize = builtFileSize(distDir, spec);
      if (dynamicSize === null) {
        ignored += 1;
        continue;
      }
      if (dynamicSize <= dynamicLimit) queue.push(spec);
      else skipped.set(spec, dynamicSize);
    }
  }

  return { files: [...files].sort(), skipped, ignored };
}

/**
 * Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG.
 *
 * Eight bytes of signature, then a four-byte length, `IHDR`, then the two big-endian 32-bit
 * dimensions. Enough to prove an icon is a real PNG of the size the manifest claims, without
 * pulling in an image library to do it.
 */
export function readPngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return null;
  }
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
