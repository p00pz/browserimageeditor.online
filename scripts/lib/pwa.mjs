/**
 * The install metadata, in one place: the manifest a browser reads, the icon set it wants, and the
 * head markup every page carries so a visitor can install the thing.
 *
 * This is a library rather than part of `gen-manifest.mjs` because four callers need the same
 * names and none of them may disagree: the manifest generator writes `icons:`, the icon generator
 * writes the files those paths point at, `build-pages.mjs` links the manifest and the touch icon
 * from every page's head, and `scripts/audit-pwa.mjs` checks both directions.
 *
 * Values come from `content/site.json` (validated in `scripts/lib/content.mjs`) rather than from
 * literals here, so the installed app's name and colours cannot drift from the site's own metadata —
 * the same rule the canonical URL and the social cards already follow.
 */

/** Where the manifest and the service worker are served from. */
export const MANIFEST_PATH = '/manifest.webmanifest';
export const SERVICE_WORKER_PATH = '/sw.js';

/**
 * The icon set. Chrome's install criteria ask for a 192px and a 512px icon; the maskable variant is
 * what stops Android cropping the glyph when it masks the icon into a circle, and the 180px
 * apple-touch-icon is what iOS uses when it puts the site on a home screen.
 *
 * `sizes` and `purpose` are the manifest's own vocabulary, so the file list here is what the
 * manifest carries — not a copy of it.
 */
export const ICONS = [
  { path: '/icons/icon-192.png', size: 192, sizes: '192x192', purpose: 'any', maskable: false, label: 'home screen' },
  { path: '/icons/icon-512.png', size: 512, sizes: '512x512', purpose: 'any', maskable: false, label: 'splash screens' },
  {
    path: '/icons/icon-512-maskable.png',
    size: 512,
    sizes: '512x512',
    purpose: 'maskable',
    maskable: true,
    label: 'Android adaptive icon',
  },
];

/** iOS ignores the manifest when adding to a home screen, so this one is a plain file reference. */
export const APPLE_TOUCH_ICON = { path: '/icons/apple-touch-icon-180.png', size: 180, maskable: false };

/** Every icon file the build is expected to produce, manifest members first. */
export const ICON_FILES = [...ICONS, APPLE_TOUCH_ICON];

/**
 * The web app manifest, built from the site metadata.
 *
 * `shortcuts` are the live tools: they are real URLs that already exist, generated from
 * content/tools.json rather than typed here, and a browser that shows them gives an installed
 * visitor a way straight into a tool.
 *
 * Deliberately absent: `screenshots`. Chrome uses them for a richer install dialog, but a
 * screenshot has to be a picture of the real app, and a generated stand-in would be a lie about
 * what installing gets you. Install works without them.
 */
export function buildManifest(site, tools = []) {
  const locale = site.locales.find((entry) => entry.code === site.defaultLocale) ?? site.locales[0];
  const manifest = {
    id: '/',
    name: site.name,
    short_name: site.shortName,
    description: site.description,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: site.backgroundColor,
    theme_color: site.themeColor,
    lang: locale?.code ?? 'en',
    dir: locale?.dir ?? 'ltr',
    categories: ['photo', 'utilities', 'productivity'],
    prefer_related_applications: false,
    icons: ICONS.map((icon) => ({
      src: icon.path,
      sizes: icon.sizes,
      type: 'image/png',
      purpose: icon.purpose,
    })),
  };

  const live = tools.filter((tool) => tool.status === 'live').slice(0, 4);
  if (live.length > 0) {
    manifest.shortcuts = live.map((tool) => ({
      name: tool.navLabel ?? tool.name,
      url: `/tools/${tool.slug}/`,
    }));
  }

  return manifest;
}

export function manifestJson(site, tools = []) {
  return `${JSON.stringify(buildManifest(site, tools), null, 2)}\n`;
}

/** The box the artwork in scripts/assets/brand-icon.svg is drawn in. */
export const GLYPH_BOX = 24;

/**
 * One icon: a background square with the glyph centred on it.
 *
 * `glyphRatio` is the glyph's width as a fraction of the canvas and `radiusRatio` the corner radius
 * as a fraction of the canvas, which is 0 for the two variants that want a full-bleed square. Kept
 * here rather than in gen-icons.mjs so the geometry is a pure function of its arguments and can be
 * checked without writing a PNG.
 */
export function composeIconSvg({ size, glyph, background, glyphRatio, radiusRatio, strokeWidth = 2 }) {
  const scale = (size * glyphRatio) / GLYPH_BOX;
  const offset = (size - GLYPH_BOX * scale) / 2;
  const radius = Math.round(size * radiusRatio);
  const short = (value) => Number(value.toFixed(4));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `  <rect width="${size}" height="${size}" rx="${radius}" fill="${background}"/>`,
    `  <g transform="translate(${short(offset)} ${short(offset)}) scale(${short(scale)})"`,
    `     fill="none" stroke="#ffffff" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">`,
    `    ${glyph}`,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

/**
 * The geometry per variant, one per entry in ICON_FILES and in the same order.
 *
 * 62% for the plain icons matches what the mark looks like in the header; 50% for the maskable one
 * sits inside the central 80% safe zone with room to spare when Android crops it to a circle.
 */
export function iconVariants(background) {
  return [
    { size: 192, glyphRatio: 0.62, radiusRatio: 0.219, background },
    { size: 512, glyphRatio: 0.62, radiusRatio: 0.219, background },
    { size: 512, glyphRatio: 0.5, radiusRatio: 0, background },
    { size: 180, glyphRatio: 0.62, radiusRatio: 0, background },
  ];
}

/** Pairs every declared icon file with the variant that produces it. */
export function iconPlan(background) {
  const variants = iconVariants(background);
  if (variants.length !== ICON_FILES.length) {
    throw new Error(
      `iconPlan: ${ICON_FILES.length} icon file(s) declared but ${variants.length} variant(s) defined`,
    );
  }
  return ICON_FILES.map((icon, index) => ({ icon, variant: variants[index] }));
}

/**
 * The head lines every page needs: the manifest link, the iOS touch icon, and a theme colour per
 * colour scheme.
 *
 * Two `theme-color` tags with `media` is the supported way to keep the browser's own chrome in step
 * with a page that has both a light and a dark theme; a single tag would be wrong in one of them.
 * Nothing here is a routing decision, so it is the same on all 25 pages.
 */
export function pwaHeadHtml(site) {
  return [
    `  <link rel="manifest" href="${MANIFEST_PATH}">`,
    `  <link rel="apple-touch-icon" sizes="180x180" href="${APPLE_TOUCH_ICON.path}">`,
    `  <meta name="theme-color" content="${site.themeColor}" media="(prefers-color-scheme: light)">`,
    `  <meta name="theme-color" content="${site.themeColorDark}" media="(prefers-color-scheme: dark)">`,
  ].join('\n');
}
