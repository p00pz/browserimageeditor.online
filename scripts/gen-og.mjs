#!/usr/bin/env node
/**
 * Social share images: one 1200x630 card per page, generated from the page's own content.
 *
 * Why a rasteriser at all: a PNG containing text needs either a rasteriser or hand-authored art.
 * `satori` (MIT) lays the template out and turns text into glyph outlines, and `@resvg/resvg-js`
 * (MPL-2.0) rasterises the result. Both are devDependencies and are never shipped to a visitor —
 * they exist only while this script runs.
 *
 * The font is vendored (`scripts/assets/fonts/`, SIL OFL-1.1) rather than taken from the host:
 * satori needs the actual font data to outline glyphs, and reading Segoe UI on Windows and DejaVu
 * on Linux would make the same run produce different bytes on different machines. The licence is
 * SIL OFL-1.1 and is recorded in `scripts/assets/fonts/LICENSE.txt` and LICENSES-THIRD-PARTY.md.
 *
 * Three artifacts:
 *   public/og/<key>.png          what og:image points at (crawlers ignore SVG)
 *   public/og/<key>.svg          the same card as vector, from the same layout
 *   scripts/assets/og-preview.html   a contact sheet of every card, needing none of the above
 *
 * The preview sheet is written first and unconditionally, because it depends on nothing: the layout
 * tree with inline styles. Opening it in a browser is how the whole set gets reviewed in one look,
 * including on a machine with no node_modules — where the PNGs are skipped with a loud warning that
 * scripts/audit-seo.mjs later turns into a failure, since a shipped page must not point at a file
 * that does not exist.
 *
 * Output:
 *   public/og/*.png, public/og/*.svg, scripts/assets/og-preview.html
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadPages,
  loadSite,
  loadTargets,
  loadTools,
  projectRoot,
  publicDir,
} from './lib/content.mjs';
import {
  generatedBanner,
  reportWrites,
  writeGenerated,
  writeGeneratedBinary,
} from './lib/render.mjs';
import { OG_HEIGHT, OG_WIDTH, ogCardTree, ogCards, ogTreeToHtml } from './lib/og-card.mjs';

const BY = 'scripts/gen-og.mjs';
const FROM = 'content/tools.json + content/targets.json + content/pages.json + content/site.json';

const FONT_DIR = resolve(projectRoot, 'scripts', 'assets', 'fonts');
// IBM Plex Sans, SIL OFL-1.1 — see scripts/assets/fonts/README.md for the commit it came from and
// the checksums of both files. The name here has to match the one the layout asks for in
// scripts/lib/og-card.mjs, or satori falls back to a font it does not have.
const FONT_FAMILY = 'IBM Plex Sans';
const FONT_FILES = [
  { file: 'IBMPlexSans-Regular.ttf', weight: 400 },
  { file: 'IBMPlexSans-Bold.ttf', weight: 700 },
];

/** A missing optional dependency is a warning here; the audit script is where it becomes fatal. */
async function optionalImport(name) {
  try {
    return await import(name);
  } catch {
    return null;
  }
}

const banner = generatedBanner({ by: BY, from: FROM });
const site = loadSite();
const tools = loadTools();
const targets = loadTargets(tools);
const pages = loadPages();

const results = [];

/* ---------- the preview sheet (no dependencies) ---------- */

const cards = site.locales.flatMap((locale) =>
  ogCards({
    site: loadSite(locale.code),
    locale: locale.code,
    tools: loadTools(locale.code),
    targets: loadTargets(loadTools(locale.code), locale.code),
    pages: loadPages(locale.code),
  }).map((card) => ({ ...card, locale: locale.code })),
);

const sheetCards = cards
  .map((card) => {
    const tree = ogTreeToHtml(card, { site });
    return [
      `    <figure class="card">`,
      `      <div class="frame">${tree}</div>`,
      `      <figcaption>${card.locale}/${card.key} — ${OG_WIDTH}×${OG_HEIGHT}</figcaption>`,
      `    </figure>`,
    ].join('\n');
  })
  .join('\n');

const sheet = `${banner}
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Social cards — ${cards.length} generated from content</title>
  <style>
    /* The layout inside each frame is inline-styled by the generator; this is only the page around
       it. Cards are shown at their true 1200x630 rather than scaled: a preview that resizes the
       thing it is previewing is a preview that can hide an overflow bug. */
    body { margin: 0; padding: 32px; background: #010409; color: #e6edf3;
           font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    p.lede { color: #8b949e; margin: 0 0 28px; max-width: 70ch; }
    .grid { display: flex; flex-direction: column; gap: 32px; }
    figure.card { margin: 0; }
    .frame { width: 1200px; height: 630px; max-width: 100%; overflow: hidden;
             border: 1px solid #30363d; border-radius: 10px; }
    figcaption { color: #6e7681; margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <h1>Social cards</h1>
  <p class="lede">Generated from content/tools.json, content/targets.json, content/pages.json and
  content/site.json. This is the exact layout the PNG and SVG cards are rendered from.</p>
  <div class="grid">
${sheetCards}
  </div>
</body>
</html>
`;

results.push(writeGenerated(resolve(projectRoot, 'scripts', 'assets', 'og-preview.html'), sheet));

/* ---------- the cards themselves ---------- */

const satori = await optionalImport('satori');
const resvg = await optionalImport('@resvg/resvg-js');
const fonts = FONT_FILES.map((entry) => ({ ...entry, path: resolve(FONT_DIR, entry.file) }));
const missingFonts = fonts.filter((font) => !existsSync(font.path));

if (!satori || !resvg || missingFonts.length > 0) {
  console.warn(
    'gen-og: wrote the preview sheet only. The PNG and SVG cards need the rasteriser:',
  );
  if (!satori) console.warn('gen-og:   satori is not installed');
  if (!resvg) console.warn('gen-og:   @resvg/resvg-js is not installed');
  for (const font of missingFonts) console.warn(`gen-og:   missing font ${font.path}`);
  console.warn(
    'gen-og: run "npm install && npm run gen:og". Until then every og:image URL 404s, and ' +
      '"npm run audit:seo" fails on purpose so that cannot ship unnoticed.',
  );
} else {
  const render = satori.default ?? satori;
  const fontData = fonts.map((font) => ({
    name: FONT_FAMILY,
    data: readFileSync(font.path),
    weight: font.weight,
    style: 'normal',
  }));

  for (const card of cards) {
    const localeSite = loadSite(card.locale);
    const directory = card.locale === site.defaultLocale ? 'og' : `${card.locale}/og`;
    const svg = await render(ogCardTree(card, { site: localeSite }), {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      fonts: fontData,
      embedFont: true,
    });
    results.push(writeGenerated(resolve(publicDir, directory, `${card.key}.svg`), svg));
    const png = new resvg.Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } })
      .render()
      .asPng();
    results.push(writeGeneratedBinary(resolve(publicDir, directory, `${card.key}.png`), Buffer.from(png)));
  }
}

reportWrites(results, { prefix: `gen-og (${cards.length} cards)` });
