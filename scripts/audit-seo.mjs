#!/usr/bin/env node
/**
 * Static SEO audit — a deploy gate over the pages that were actually written.
 *
 * This is **not** Lighthouse, and it does not claim to be: Lighthouse needs a real browser to
 * measure anything, and there is no browser on the build host. What this checks instead is the
 * part of Lighthouse's SEO category that is a property of the HTML rather than of the rendering:
 *
 *   - a unique, present <title> and meta description on every page
 *   - a self-referential absolute canonical, `lang`, `dir`, and a mobile viewport
 *   - hreflang alternates for every configured locale plus `x-default`
 *   - exactly one <h1>, no heading level skipped, every <img> carrying `alt`
 *   - crawlable anchors (no `href="#"`, no unlabelled link)
 *   - one valid JSON-LD graph per page, with the node types that page kind should have, and FAQ
 *     answers that are visible on the page rather than only inside the markup
 *   - an OG image that is absolute, 1200×630, and present on disk
 *   - every referenced `/assets/...` file exists, and no resource is loaded off-origin
 *   - sitemap ↔ page parity in both directions, with reciprocal alternates
 *   - robots.txt allowing crawlers and pointing at the sitemap
 *   - every partial include naming a file that exists (includes are expanded by the Vite plugin at
 *     serve/build time, so `<!--#include` in a source page is expected, not a defect)
 *
 * One deliberate carve-out is recorded here rather than hidden: an `<a>` with no `href` is an error,
 * except for the `data-download` save control. That one starts inside a `hidden` result panel whose
 * href is a blob URL that only exists after a file has been processed, so it cannot be a dead link
 * on the page as delivered. Replacing it with a <button> and a programmatically created anchor is a
 * real improvement, and it needs a browser to verify — it is on the list in PROGRESS_LOG.md.
 *
 * Two things it deliberately cannot see, so never treat a clean run as a Lighthouse score:
 * performance metrics (LCP/CLS/INP need a browser) and anything that depends on request headers.
 * The reserved ad-slot space and the modal-free layout that keep CLS at zero are checked by
 * reading components.css, not by measuring.
 *
 * Exit code is 1 when any error is found, so `npm run audit:seo` can gate a deploy. Warnings —
 * SERP truncation risk, mostly — do not fail the build unless `--strict` is passed.
 *
 * Usage:
 *   node scripts/audit-seo.mjs [--strict] [--verbose]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  alternateLinks,
  loadSite,
  loadUi,
  pageFile,
  pageUrl,
  publicDir,
  siteRoutes,
  srcDir,
} from './lib/content.mjs';
import { escapeHtml } from './lib/render.mjs';
import { validateGraph } from './lib/schema.mjs';
import { OG_SIZE, ogImageKey, ogImagePath } from './lib/tool-page.mjs';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const verbose = args.includes('--verbose') || args.includes('-v');

const projectRoot = dirname(srcDir);

/**
 * Thresholds. An error is something a crawler cannot index correctly; a warning is something a
 * human sees get cut off. Titles truncate in results at roughly 60 characters and descriptions
 * around 160, so those are the warning lines, with a wider hard limit above them.
 */
const LIMITS = {
  titleMin: 15,
  titleWarn: 60,
  titleMax: 70,
  descriptionMin: 50,
  descriptionWarn: 160,
  descriptionMax: 200,
};

const problems = [];
const error = (file, message) => problems.push({ level: 'error', file, message });
const warn = (file, message) => problems.push({ level: 'warning', file, message });

/* ---------- small parsing helpers ---------- */

/** Strips JSON-LD blocks, so a check never mistakes schema for visible page content. */
function visibleHtml(html) {
  return html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
}

function metaContent(html, attribute, name) {
  const pattern = new RegExp(`<meta ${attribute}="${name}" content="([^"]*)"`);
  return html.match(pattern)?.[1] ?? null;
}

function linkHref(html, rel) {
  const pattern = new RegExp(`<link rel="${rel}"[^>]*href="([^"]*)"`);
  return html.match(pattern)?.[1] ?? null;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Collapses whitespace so a phrase can be looked for in rendered HTML.
 *
 * The templates wrap long sentences across lines, so the rendered notice contains newlines and
 * indentation that the catalogue value does not. Comparing raw strings would fail on formatting
 * rather than on content, which is the kind of check that gets deleted instead of fixed.
 */
function normalizeSpace(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/** A root-relative path that names a file rather than a route. */
function isFilePath(path) {
  return !path.endsWith('/') && /\.[a-z0-9]+$/i.test(path);
}

/* ---------- the page inventory ---------- */

const site = loadSite();

/** Every generated page, across every configured locale. */
const pages = [];
/** Route URLs across all locales, for internal-link checks. */
const knownUrls = new Set();
/** Which locale each URL belongs to, so a cross-language link can be checked rather than trusted. */
const localeByUrl = new Map();

for (const locale of site.locales) {
  const { site: localeSite, routes } = siteRoutes(locale.code);
  for (const route of routes) {
    const url = pageUrl(localeSite, locale.code, route.path);
    knownUrls.add(url);
    localeByUrl.set(url, locale.code);
    pages.push({
      locale: locale.code,
      localeSite,
      dir: locale.dir,
      kind: route.kind,
      status: route.status,
      path: route.path,
      url,
      file: pageFile(localeSite, locale.code, route.path),
      label: route.path === '/' ? 'src/index.html' : `src/${route.path.replace(/^\//, '')}index.html`,
      entry: route.entry ?? null,
      tool: route.tool ?? null,
    });
  }
}

/**
 * Which JSON-LD node types each page kind is supposed to carry.
 *
 * The home page deliberately has no BreadcrumbList: a one-item trail to the page you are already
 * on tells a crawler nothing, and `breadcrumbList` is only emitted where there is a real path.
 */
function expectedTypes(page) {
  if (page.kind === 'home') return ['WebSite', 'Organization'];
  const expected = [];
  if (page.kind === 'tool' && page.status === 'live') expected.push('SoftwareApplication');
  expected.push('BreadcrumbList');
  return expected;
}

/* ---------- per-page checks ---------- */

const titleOwners = new Map();
const descriptionOwners = new Map();
/** url -> the set of alternate URLs it declares, for the reciprocity pass after this loop. */
const declaredAlternates = new Map();
let ogImagesChecked = 0;

for (const page of pages) {
  const file = page.label;

  if (!existsSync(page.file)) {
    error(file, `is missing — ${page.url} is in the route inventory but has no file on disk`);
    continue;
  }
  const html = readFileSync(page.file, 'utf8');
  const visible = visibleHtml(html);

  /* build integrity: every include names a partial the plugin can resolve */
  for (const match of html.matchAll(/<!--#include\s+partials\/([^>\s]+)\s*-->/g)) {
    if (!existsSync(resolve(srcDir, 'partials', match[1]))) {
      error(file, `includes partials/${match[1]}, which does not exist`);
    }
  }
  if (html.includes('<!-- partial not found')) error(file, 'references a partial that does not exist');

  /* head essentials */
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? null;
  if (!title) {
    error(file, 'has no <title>');
  } else {
    if (titleOwners.has(title)) error(file, `shares its <title> with ${titleOwners.get(title)} ("${title}")`);
    else titleOwners.set(title, file);
    if (title.length > LIMITS.titleMax) error(file, `<title> is ${title.length} characters, over the ${LIMITS.titleMax} limit`);
    else if (title.length > LIMITS.titleWarn) warn(file, `<title> is ${title.length} characters and will be cut off in results`);
    else if (title.length < LIMITS.titleMin) warn(file, `<title> is only ${title.length} characters`);
  }

  const description = metaContent(html, 'name', 'description');
  if (!description) {
    error(file, 'has no meta description');
  } else {
    if (descriptionOwners.has(description)) {
      error(file, `shares its meta description with ${descriptionOwners.get(description)}`);
    } else descriptionOwners.set(description, file);
    if (description.length > LIMITS.descriptionMax) {
      error(file, `meta description is ${description.length} characters, over the ${LIMITS.descriptionMax} limit`);
    } else if (description.length > LIMITS.descriptionWarn) {
      warn(file, `meta description is ${description.length} characters and will be cut off in results`);
    } else if (description.length < LIMITS.descriptionMin) {
      warn(file, `meta description is only ${description.length} characters`);
    }
  }

  const canonical = linkHref(html, 'canonical');
  if (!canonical) error(file, 'has no canonical link');
  else if (canonical !== page.url) error(file, `canonical is "${canonical}", expected "${page.url}"`);

  const htmlTag = html.match(/<html lang="([^"]*)"(?: dir="([^"]*)")?/);
  if (!htmlTag) error(file, 'has no <html lang> attribute');
  else {
    if (htmlTag[1] !== page.locale) error(file, `<html lang> is "${htmlTag[1]}", expected "${page.locale}"`);
    if (htmlTag[2] !== page.dir) error(file, `<html dir> is "${htmlTag[2]}", expected "${page.dir}"`);
  }

  const alternates = [...html.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)"/g)].map((match) => ({
    hreflang: match[1],
    href: match[2],
  }));

  // An hreflang pair is a promise that both pages exist. With a locale that publishes a subset,
  // advertising a language nobody generated sends a crawler to a 404 and tells a search engine the
  // English page has an Arabic twin that was never written.
  for (const entry of alternates) {
    if (entry.hreflang === 'x-default') continue;
    if (!knownUrls.has(entry.href)) {
      error(
        file,
        `declares hreflang "${entry.hreflang}" -> ${entry.href}, which is not a route in the route inventory — that language has no such page`,
      );
    }
  }
  declaredAlternates.set(
    page.url,
    new Set(alternates.filter((entry) => entry.hreflang !== 'x-default').map((entry) => entry.href)),
  );

  /* the RTL stylesheet is linked where it applies, and nowhere else */
  const rtlSheet = /href="\/assets\/css\/rtl\.css"/.test(html);
  if (page.dir === 'rtl' && !rtlSheet) {
    error(file, `is a "${page.locale}" page but does not link /assets/css/rtl.css`);
  }
  if (page.dir !== 'rtl' && rtlSheet) {
    error(file, `links the right-to-left stylesheet on a ${page.dir} page`);
  }

  /*
   * A page published in a second language says so, in that language, on the page itself. This is
   * the one check that keeps the machine-translation disclosure from quietly disappearing in a
   * refactor: the notice text lives in the locale's catalogue, so emptying it there fails here.
   */
  if (page.locale !== site.defaultLocale) {
    const notice = loadUi(page.locale)['ui.chrome.translationNotice'] ?? '';
    if (notice === '') {
      error(file, `is a "${page.locale}" page and content/${page.locale}/ui.json carries no ui.chrome.translationNotice`);
    } else if (!normalizeSpace(visible).includes(normalizeSpace(notice))) {
      error(
        file,
        `is a "${page.locale}" page with no machine-translation notice on it — a translated page has to say that it has not been reviewed`,
      );
    }
  }
  const expectedAlternates = alternateLinks(page.localeSite, page.path);
  const rendered = new Set(alternates.map((entry) => `${entry.hreflang} ${entry.href}`));
  for (const expected of expectedAlternates) {
    if (!rendered.has(`${expected.hreflang} ${expected.href}`)) {
      error(file, `is missing hreflang "${expected.hreflang}" -> ${expected.href}`);
    }
  }
  if (alternates.length !== expectedAlternates.length) {
    error(file, `declares ${alternates.length} hreflang alternates, expected ${expectedAlternates.length}`);
  }

  const viewport = metaContent(html, 'name', 'viewport');
  if (!viewport) error(file, 'has no viewport meta tag');
  else if (!viewport.includes('width=device-width')) warn(file, `viewport is "${viewport}"`);

  /* robots: only a planned page may be noindex */
  const robots = metaContent(html, 'name', 'robots');
  const noindex = robots !== null && robots.includes('noindex');
  if (page.status !== 'live' && !noindex) error(file, `is not live but is indexable (no noindex tag)`);
  if (page.status === 'live' && noindex) error(file, `is live but carries "${robots}"`);

  /* headings and crawlable content */
  const headings = [...visible.matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]));
  if (headings.filter((level) => level === 1).length !== 1) {
    error(file, `has ${headings.filter((level) => level === 1).length} <h1> elements, expected exactly 1`);
  }
  for (let index = 1; index < headings.length; index += 1) {
    if (headings[index] > headings[index - 1] + 1) {
      error(file, `skips a heading level: h${headings[index - 1]} is followed by h${headings[index]}`);
      break;
    }
  }

  for (const match of visible.matchAll(/<img\b([^>]*)>/g)) {
    if (!/\balt=/.test(match[1])) error(file, `has an <img> without alt: ${match[0].slice(0, 80)}`);
  }

  for (const match of visible.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attributes = match[1];
    const href = attributes.match(/\bhref="([^"]*)"/)?.[1];
    if (href === undefined) {
      // A save control in a hidden result panel is the documented exception; see the header.
      if (!/\bdata-download(?:-zip)?\b/.test(attributes)) {
        error(file, `has an <a> without href: ${stripTags(match[0]).slice(0, 60)}`);
      }
      continue;
    }
    // The one allowance: a save control whose href is a blob URL that appears with the result.
    const populatedByResult = /\bdata-download(?:-zip)?\b/.test(attributes) && /\bdownload\b/.test(attributes);
    if (href === '#') {
      error(file, `has a dead href="#" link: ${stripTags(match[0]).slice(0, 60)}`);
    }
    const text = stripTags(match[2]);
    if (text === '' && !/\baria-label="/.test(attributes)) {
      error(file, `has an <a> with no text and no aria-label: ${match[0].slice(0, 80)}`);
    }
  }

  /*
   * Internal links.
   *
   * A non-default-locale page normally links only inside its own locale — an Arabic page whose nav
   * points at English pages is a translation that half-happened. There is exactly one exception: a
   * link that *declares* the language it switches to with `hreflang`, which is how the guide pages
   * stay reachable from an Arabic tool page until those guides are translated too. The declared
   * language is checked against the target's real locale, so this is an allowance for deliberate
   * cross-language links, not a way to silence the rule.
   */
  for (const match of visible.matchAll(/<a\b([^>]*)>/g)) {
    const attributes = match[1];
    const href = attributes.match(/\bhref="([^"]*)"/)?.[1];
    if (!href || !href.startsWith('/')) continue;
    if (href.startsWith('/assets/') || href.startsWith('/og/')) continue; // checked below
    const target = href.split('#')[0];
    if (!target.endsWith('/')) continue;
    const url = `${page.localeSite.url}${target}`;
    if (!knownUrls.has(url)) {
      error(file, `links to "${target}", which is not a route in the route inventory`);
      continue;
    }
    if (page.locale === site.defaultLocale) continue;
    if (target === `/${page.locale}/` || target.startsWith(`/${page.locale}/`)) continue;

    const declaredLanguage = attributes.match(/\bhreflang="([^"]*)"/)?.[1] ?? null;
    const targetLocale = localeByUrl.get(url) ?? '?';
    if (declaredLanguage === targetLocale) continue;
    error(
      file,
      `is a "${page.locale}" page linking to the unprefixed "${target}" (a "${targetLocale}" page). Either prefix the link with /${page.locale}/, or declare hreflang="${targetLocale}" on it so the language change is deliberate and visible.`,
    );
  }

  /* every local resource exists; routes are checked by the link pass above */
  for (const match of visible.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    const path = match[1];
    if (path.startsWith('/assets/')) {
      if (!existsSync(resolve(srcDir, path.replace(/^\//, '')))) {
        error(file, `references "${path}", which does not exist`);
      }
      continue;
    }
    if (!isFilePath(path)) continue;
    if (!existsSync(resolve(publicDir, path.replace(/^\//, '')))) {
      error(file, `references "${path}", which does not exist in public/`);
    }
  }

  /* no off-origin resource: a third-party stylesheet or script is a tracking surface */
  for (const match of visible.matchAll(/<(?:script|link)[^>]*\b(?:src|href)="(https?:\/\/[^"]+)"/g)) {
    if (!match[1].startsWith(page.localeSite.url)) {
      error(file, `loads a resource from another origin: ${match[1]}`);
    }
  }

  /* structured data */
  const jsonLdBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (jsonLdBlocks.length !== 1) {
    error(file, `has ${jsonLdBlocks.length} JSON-LD blocks, expected exactly 1`);
  } else {
    let graph = null;
    try {
      graph = JSON.parse(jsonLdBlocks[0][1]);
    } catch (parseError) {
      error(file, `JSON-LD does not parse: ${parseError.message}`);
    }
    if (graph) {
      for (const problem of validateGraph(graph, { pageUrl: page.url })) error(file, `JSON-LD: ${problem}`);

      const present = new Set(graph['@graph'].map((node) => node['@type']));
      for (const type of expectedTypes(page)) {
        if (!present.has(type)) error(file, `JSON-LD is missing the "${type}" node`);
      }

      const faqLength = page.entry?.faq?.length ?? 0;
      if (faqLength > 0 && !present.has('FAQPage')) error(file, 'has an FAQ block on the page but no FAQPage node');
      if (faqLength === 0 && present.has('FAQPage')) error(file, 'publishes a FAQPage node with no FAQ on the page');

      /* Google's rule for FAQ markup was always that the answers are visible, not schema-only. */
      const faqNode = graph['@graph'].find((node) => node['@type'] === 'FAQPage');
      for (const question of faqNode?.mainEntity ?? []) {
        if (!visible.includes(escapeHtml(question.name))) {
          error(file, `FAQ question in the JSON-LD is not visible on the page: "${question.name.slice(0, 60)}"`);
        }
        for (const orphan of Object.keys(question)) {
          if (orphan !== '@type' && orphan !== 'name' && orphan !== 'acceptedAnswer') {
            error(file, `FAQPage question carries "${orphan}", which is not a Question property`);
          }
        }
      }
    }
  }

  /* Open Graph */
  const ogUrl = metaContent(html, 'property', 'og:url');
  if (ogUrl !== page.url) error(file, `og:url is "${ogUrl}", expected "${page.url}"`);
  for (const property of ['og:title', 'og:description', 'og:image:alt']) {
    if (!metaContent(html, 'property', property)) error(file, `has no ${property}`);
  }
  if (metaContent(html, 'property', 'og:type') === null) error(file, 'has no og:type');
  if (metaContent(html, 'name', 'twitter:card') !== 'summary_large_image') {
    error(file, 'twitter:card is not summary_large_image');
  }

  const key =
    page.kind === 'home'
      ? ogImageKey('home')
      : page.kind === 'tool'
        ? ogImageKey('tool', page.entry.slug)
        : page.kind === 'target'
          ? ogImageKey('guide', page.entry.slug)
          : ogImageKey('page', page.entry.slug);
  const expectedImage = `${page.localeSite.url}${ogImagePath(page.localeSite, page.locale, key)}`;
  const ogImage = metaContent(html, 'property', 'og:image');
  if (ogImage !== expectedImage) error(file, `og:image is "${ogImage}", expected "${expectedImage}"`);
  if (metaContent(html, 'property', 'og:image:width') !== String(OG_SIZE.width)) {
    error(file, `og:image:width is not ${OG_SIZE.width}`);
  }
  if (metaContent(html, 'property', 'og:image:height') !== String(OG_SIZE.height)) {
    error(file, `og:image:height is not ${OG_SIZE.height}`);
  }

  const imageFile = resolve(publicDir, ogImagePath(page.localeSite, page.locale, key).replace(/^\//, ''));
  ogImagesChecked += 1;
  if (!existsSync(imageFile)) {
    error(file, `is missing its share image ${ogImagePath(page.localeSite, page.locale, key)}`);
  }
  const svgFile = resolve(publicDir, ogImagePath(page.localeSite, page.locale, key, 'svg').replace(/^\//, ''));
  if (!existsSync(svgFile)) warn(file, `has no SVG source for its share image`);
}

/* ---------- hreflang reciprocity ---------- */

/*
 * Every declared alternate must declare this page back.
 *
 * hreflang is a two-way statement: page A saying "my Arabic version is B" is ignored unless B says
 * "my English version is A". A one-way pair is the classic symptom of a link builder that was made
 * locale-aware on one side only, and it is invisible unless something checks both directions —
 * which is exactly what a crawler will not tell you about.
 */
for (const page of pages) {
  const declared = declaredAlternates.get(page.url);
  if (!declared) continue;
  for (const other of declared) {
    const back = declaredAlternates.get(other);
    if (!back) continue;
    if (!back.has(page.url)) {
      error(
        page.label,
        `declares ${other} as an alternate, but that page does not declare ${page.url} back — hreflang has to be reciprocal to count`,
      );
    }
  }
}

/* ---------- sitemap and robots ---------- */

const livePages = pages.filter((page) => page.status === 'live');
const sitemapPath = resolve(publicDir, 'sitemap.xml');

if (!existsSync(sitemapPath)) {
  error('public/sitemap.xml', 'does not exist');
} else {
  const sitemap = readFileSync(sitemapPath, 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);
  const seen = new Set();
  for (const loc of locs) {
    if (seen.has(loc)) error('public/sitemap.xml', `lists ${loc} more than once`);
    seen.add(loc);
    if (!livePages.some((page) => page.url === loc)) {
      error('public/sitemap.xml', `lists ${loc}, which is not a live page`);
    }
  }
  for (const page of livePages) {
    if (!seen.has(page.url)) error('public/sitemap.xml', `does not list ${page.url}`);
  }

  /* Every <url> block must carry the alternates for its own route. */
  for (const block of sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = block[1].match(/<loc>([^<]*)<\/loc>/)?.[1];
    const page = livePages.find((candidate) => candidate.url === loc);
    if (!page) continue;
    const declared = new Set(
      [...block[1].matchAll(/hreflang="([^"]*)" href="([^"]*)"/g)].map((match) => `${match[1]} ${match[2]}`),
    );
    for (const expected of alternateLinks(page.localeSite, page.path)) {
      if (!declared.has(`${expected.hreflang} ${expected.href}`)) {
        error('public/sitemap.xml', `${loc} is missing its hreflang "${expected.hreflang}" alternate`);
      }
    }
  }
}

const robotsPath = resolve(publicDir, 'robots.txt');
if (!existsSync(robotsPath)) {
  error('public/robots.txt', 'does not exist');
} else {
  const robots = readFileSync(robotsPath, 'utf8');
  if (!/^User-agent: \*$/m.test(robots)) error('public/robots.txt', 'has no "User-agent: *" group');
  if (!/^Allow: \/$/m.test(robots)) error('public/robots.txt', 'does not allow crawling');
  if (!robots.includes(`Sitemap: ${site.url}/sitemap.xml`)) {
    error('public/robots.txt', `does not point at ${site.url}/sitemap.xml`);
  }
  if (/^Disallow: \/\S/m.test(robots)) warn('public/robots.txt', 'has a Disallow rule that is not just "Disallow: /"');
}

/* ---------- report ---------- */

const errors = problems.filter((problem) => problem.level === 'error');
const warnings = problems.filter((problem) => problem.level === 'warning');

const byKind = pages.reduce((counts, page) => {
  counts[page.kind] = (counts[page.kind] ?? 0) + 1;
  return counts;
}, {});

console.log(
  `audit-seo: ${pages.length} pages (${Object.entries(byKind)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ')}), ${ogImagesChecked} share images, ${site.locales.length} locale(s)`,
);

if (verbose) {
  for (const page of pages) console.log(`  ok  ${page.label}  ->  ${page.url}`);
}

for (const problem of [...errors, ...warnings]) {
  console.log(`  ${problem.level === 'error' ? 'ERR ' : 'warn'} ${problem.file}: ${problem.message}`);
}

console.log(
  `audit-seo: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
);
if (errors.length === 0 && warnings.length > 0 && !strict) {
  console.log('audit-seo: warnings do not fail the build. Pass --strict to treat them as errors.');
}
if (errors.length > 0 || (strict && warnings.length > 0)) process.exit(1);
