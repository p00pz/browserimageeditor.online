import { defineConfig } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(projectRoot, 'src');
const partialsDir = resolve(srcDir, 'partials');

// <!--#include partials/header.html--> is expanded here, identically for the dev server and
// the production build, so a page can never render differently in one than in the other.
const INCLUDE_PATTERN = /<!--#include\s+partials\/([^>\s]+)\s*-->/g;

// A partial may include another partial (the footer includes the generated page nav), so an
// include is expanded repeatedly until the document stops changing. The depth guard turns a
// partial that includes itself into a no-op rather than an infinite loop.
const inlinePartialsDeep = (html, depth = 5) =>
  depth <= 0 || !html.includes('<!--#include') ? html : inlinePartialsDeep(inlinePartials(html), depth - 1);

function inlinePartials(html) {
  return html.replace(INCLUDE_PATTERN, (match, filename) => {
    try {
      return readFileSync(resolve(partialsDir, filename), 'utf-8');
    } catch {
      return `<!-- partial not found: ${filename} -->`;
    }
  });
}

function partialsPlugin() {
  return {
    name: 'partials',
    transformIndexHtml(html) {
      return inlinePartialsDeep(html);
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.endsWith('.html')) {
          const url = req.url.split('?')[0];
          const filePath = resolve(srcDir, url === '/' ? 'index.html' : url.slice(1));
          try {
            const html = inlinePartialsDeep(readFileSync(filePath, 'utf-8'));
            res.setHeader('Content-Type', 'text/html');
            return res.end(html);
          } catch {
            // fall through to next middleware
          }
        }
        next();
      });
    }
  };
}

/**
 * Every index.html under src/ is a real, separately indexable page.
 *
 * Tool and target pages are produced by `npm run gen`, which runs before both `dev` and
 * `build`, so this list is discovered from disk and never hand-maintained in this file.
 */
function findPageEntries(dir, entries = {}, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      findPageEntries(full, entries, `${prefix}${entry.name}/`);
    } else if (entry.name === 'index.html') {
      entries[prefix === '' ? 'main' : prefix.replace(/\/$/, '')] = full;
    }
  }
  return entries;
}

export default defineConfig({
  root: 'src',
  base: '/',
  publicDir: '../public',
  // MPA, not SPA: an unknown path must 404 instead of quietly serving index.html.
  appType: 'mpa',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: findPageEntries(srcDir),
    },
  },
  // Workers are emitted as ES modules so they can import ../core/engine-*.js directly,
  // which keeps one source of truth for the logic.
  worker: {
    format: 'es',
  },
  plugins: [partialsPlugin()],
  server: {
    port: 5173,
    open: true,
  },
});
