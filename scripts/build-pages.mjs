#!/usr/bin/env node
/**
 * Generates every tool page, every standalone page, the homepage, the homepage tool grid and both
 * navs from content/tools.json, content/pages.json and content/site.json. Nothing in this file may
 * hard-code a tool name, title, description or URL path — those all live in the content files.
 *
 * Status decides everything about a tool page:
 *   live     the working tool, with its #tool-config block and its engine script
 *   planned  a "not built yet" page: no script (there is no engine file to load), no config,
 *            and noindex so a thin page is not what search engines see first
 *
 * Every page is generated once per configured locale (`content/site.json` -> `locales`). The
 * default locale is prefixless, so declaring a second language adds `/ar/...` URLs and a nested
 * output directory without moving a single existing URL. Routes, canonical URLs and output paths
 * all come from the helpers in scripts/lib/content.mjs rather than from string concatenation here.
 *
 * Each page's head carries its own canonical, its hreflang alternates, its own social card, and one
 * JSON-LD graph built by scripts/lib/schema.mjs — all derived from the same content the body is
 * rendered from, so the head cannot disagree with the page.
 *
 * Output:
 *   src/index.html                   the homepage (head built from content/site.json)
 *   src/tools/<slug>/index.html      one page per tool
 *   src/pages/<slug>/index.html      standalone pages (about, privacy, terms, ...)
 *   src/<locale>/...                 the same routes for a non-default locale
 *   src/partials/tool-grid.html      homepage grid
 *   src/partials/nav-tools.html      <li> items for the header nav
 *   src/partials/nav-pages.html      footer links to the standalone pages
 *   src/partials/nav-header-pages.html  the ones that belong in the header nav
 */
import { resolve } from 'node:path';
import {
  loadPages,
  loadSite,
  loadTargets,
  loadTools,
  loadUi,
  markupStrings,
  pageFile,
  pagePath,
  localePath,
  pageUrl,
  partialsPrefix,
  runtimeStrings,
  srcDir,
  toolPath,
} from './lib/content.mjs';
import {
  escapeHtml,
  findPlaceholders,
  generatedBanner,
  interpolate,
  readLocaleTemplate,
  readTemplate,
  render,
  reportPlaceholders,
  reportWrites,
  writeGenerated,
} from './lib/render.mjs';
import {
  breadcrumbList,
  faqPage,
  jsonLdScript,
  organization,
  softwareApplication,
  webSite,
} from './lib/schema.mjs';
import { pwaHeadHtml } from './lib/pwa.mjs';
import {
  acceptHint,
  adSlotsHtml,
  alternatesHtml,
  chromeStrings,
  faqHtml,
  guidesHtml,
  langSwitchHtml,
  ogImageKey,
  ogImageUrl,
  ogTags,
  rtlHeadHtml,
  secondarySection,
  toolCard,
  toolConfig,
  toolOgTags,
  translationNoticeHtml,
  uiStringsBlock,
} from './lib/tool-page.mjs';

const BY = 'scripts/build-pages.mjs';
const FROM = 'content/tools.json + content/pages.json + content/site.json';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const site = loadSite();
const tools = loadTools();
const pages = loadPages();

const banner = generatedBanner({ by: BY, from: FROM });

/**
 * Deterministic date label: no Date parsing, so the generators stay idempotent.
 *
 * The month name comes from the locale's catalogue rather than from `Intl`, for two reasons: the
 * build stays independent of whatever ICU data the machine running it happens to ship, and a month
 * name is copy — a reviewer checking the Arabic should find «سبتمبر» in the same file as the rest of
 * the wording. The English values reproduce the hardcoded list exactly, byte for byte.
 */
function formatIsoDate(iso, catalog) {
  const [year, month, day] = iso.split('-').map(Number);
  const monthName = catalog?.[`ui.chrome.month.${String(month).padStart(2, '0')}`] ?? MONTHS[month - 1];
  if (!monthName || !year || !day) return iso;
  return `${day} ${monthName} ${year}`;
}

/** Related tools are listed by id and only linked once they are live. */
function relatedHtml(tool, toolList, strings, prefix = '') {
  const related = tool.related
    .map((id) => toolList.find((candidate) => candidate.id === id))
    .filter((candidate) => candidate && candidate.status === 'live');
  if (related.length === 0) return '';
  const cards = related
    .map(
      (item) =>
        `    <li class="tool-card">\n      <a class="tool-card-link" href="${prefix}${toolPath(item)}">\n        <span class="tool-card-name">${escapeHtml(item.name)}</span>\n        <span class="tool-card-desc">${escapeHtml(item.description)}</span>\n      </a>\n    </li>`,
    )
    .join('\n');
  return secondarySection({
    className: 'related-tools',
    heading: strings.relatedHeading,
    body: `    <ul class="tool-grid">\n${cards}\n    </ul>`,
  });
}

/**
 * The generated partials, one set per locale.
 *
 * A non-default locale's pages include `partials/<code>/<name>.html`, which is why these take the
 * locale's own tool and page lists and its own strings: an Arabic nav must list the three tools
 * that exist in Arabic, each linking to its Arabic URL, rather than the English nav with translated
 * labels pointing at English pages.
 */
function toolGridPartial(toolList, code, strings) {
  const prefix = code === site.defaultLocale ? '' : `/${code}`;
  const items = toolList
    .map((tool) => toolCard(tool, { badge: tool.status !== 'live', strings, prefix }))
    .join('\n');
  return `${banner}\n<ul class="tool-grid">\n${items}\n</ul>\n`;
}

function navToolsPartial(toolList, code) {
  const prefix = code === site.defaultLocale ? '' : `${code}/`;
  const items = toolList
    .map((tool) =>
      tool.status === 'live'
        ? `  <li><a href="/${prefix}${toolPath(tool).replace(/^\//, '')}" class="nav-link">${escapeHtml(tool.navLabel)}</a></li>`
        : `  <li><span class="nav-link nav-link-disabled" aria-disabled="true">${escapeHtml(tool.navLabel)}</span></li>`,
    )
    .join('\n');
  return `${banner}\n${items}\n`;
}

/**
 * Links to the standalone pages, in the markup the place expects: the header wants list items,
 * the footer wants inline links with separators. Both derive from content/pages.json, so a new
 * page shows up in both places without touching any HTML.
 */
function navPagesPartial({ place = 'footer', pageList = pages, code = site.defaultLocale } = {}) {
  const visible = pageList.filter((page) => page.status === 'live' && page.nav.includes(place));
  const prefix = code === site.defaultLocale ? '' : `${code}/`;
  const href = (page) => `/${prefix}${pagePath(page).replace(/^\//, '')}`;

  if (place === 'header') {
    const items = visible.map(
      (page) => `  <li><a href="${href(page)}" class="nav-link">${escapeHtml(page.navLabel)}</a></li>`,
    );
    return `${banner}\n${items.join('\n')}\n`;
  }

  const links = visible.map(
    (page) => `  <a href="${href(page)}" class="footer-link">${escapeHtml(page.navLabel)}</a>`,
  );
  const separator = `  <span class="footer-separator" aria-hidden="true">·</span>`;
  return `${banner}\n${links.join(`\n${separator}\n`)}\n`;
}

/** The live tools, listed on a coming-soon page so a visitor has somewhere useful to go. */
function liveToolsHtml(toolList, strings, prefix = '') {
  const live = toolList.filter((tool) => tool.status === 'live');
  if (live.length === 0) return `    <p>${escapeHtml(strings.noLiveTools)}</p>`;
  const items = live.map((tool) => toolCard(tool, { indent: '    ', strings, prefix })).join('\n');
  return `    <ul class="tool-grid">\n${items}\n    </ul>`;
}

/** The live target pages that belong to one tool, in content order. */
function guidesFor(tool, targetList) {
  return targetList.filter((target) => target.status === 'live' && target.parentToolId === tool.id);
}

/** The path of a generated file, as reported in the audit list. */
function srcLabel(defaultLocale, locale, path) {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const prefix = locale === defaultLocale ? '' : `${locale}/`;
  return `src/${prefix}${clean === '' ? '' : `${clean}/`}index.html`;
}

const results = [];
const audits = [];

for (const locale of site.locales) {
  const code = locale.code;
  const lang = code;
  const dir = locale.dir;
  const localeSite = loadSite(code);
  const localeTools = loadTools(code);
  const localePages = loadPages(code);
  const localeTargets = loadTargets(localeTools, code);
  const catalog = loadUi(code);
  const strings = chromeStrings(catalog);
  /** `''` for the default locale, `'/ar'` otherwise: the prefix every in-page link needs. */
  const localePrefix = code === site.defaultLocale ? '' : `/${code}`;

  /**
   * Head values every page kind shares: language, alternates, the canonical URL, install hints and
   * the string catalogue's markup half.
   *
   * `markupStrings` is spread in last so a template can reach any `ui.*` string as `{{t.ui.…}}`
   * without the call site naming each one. `langSwitch` and `homeHref` are functions of the path,
   * which is why this is a function rather than an object.
   */
  const head = (path) => ({
    lang,
    dir,
    siteName: localeSite.name,
    canonical: pageUrl(localeSite, code, path),
    alternates: alternatesHtml(localeSite, path),
    pwaHead: pwaHeadHtml(localeSite),
    rtlHead: rtlHeadHtml(locale),
    langSwitch: langSwitchHtml(localeSite, code, path, catalog),
    translationNotice: translationNoticeHtml(locale, catalog, site.defaultLocale),
    uiStrings: uiStringsBlock(runtimeStrings(catalog)),
    homeHref: localePath(localeSite, code, '/'),
    partials: partialsPrefix(site, code),
    ...markupStrings(catalog),
  });

  /* ---------- tool pages ---------- */

  const toolTemplate = readTemplate('tool.template.html');
  const plannedTemplate = readTemplate('tool-planned.template.html');

  for (const tool of localeTools) {
    const isLive = tool.status === 'live';
    const path = toolPath(tool);
    const url = pageUrl(localeSite, code, path);
    const imageUrl = ogImageUrl(localeSite, code, ogImageKey('tool', tool.slug));

    // A planned tool is not an app yet, so it carries no SoftwareApplication node — claiming one
    // would describe something that does not exist. Its FAQ is on the page, so that is marked.
    const jsonLd = jsonLdScript([
      isLive ? softwareApplication({ tool, url, lang, imageUrl }) : null,
      tool.faq.length > 0 ? faqPage({ url, faq: tool.faq }) : null,
      breadcrumbList({
        url,
        items: [
          // The locale's own homepage, not the site root: an Arabic page whose breadcrumb points at
          // the English homepage is a wrong URL in machine-readable markup.
          { name: catalog['ui.chrome.allTools'], url: pageUrl(localeSite, code, '/') },
          { name: tool.name, url },
        ],
      }),
    ]);

    const shared = {
      banner,
      ...head(path),
      title: tool.title,
      description: tool.description,
      ogTags: toolOgTags(tool, localeSite, code, interpolate(catalog['ui.shell.toolOgAlt'], { name: tool.name })),
      jsonLd,
      name: tool.name,
      slug: tool.slug,
      h1: tool.h1,
      intro: tool.intro,
      acceptAttr: tool.accepts.join(','),
      acceptHint: acceptHint(tool, strings),
      dropzoneHint: interpolate(catalog['ui.tool.dropzoneHint'], { acceptHint: acceptHint(tool, strings) }),
      toolConfig: toolConfig(tool),
      toolScript: `/assets/js/tools/${tool.slug}.js`,
      liveToolsHtml: liveToolsHtml(localeTools, strings, localePrefix),
      guidesHtml: guidesHtml(guidesFor(tool, localeTargets), {
        heading: strings.guidesHeading,
        prefix: localePrefix,
      }),
      adSlots: adSlotsHtml({ site: localeSite, place: 'below-tool' }),
      faqHtml: faqHtml(tool, strings),
      relatedHtml: relatedHtml(tool, localeTools, strings, localePrefix),
    };

    // A live tool's panel is its own fragment, mirroring src/templates/pages/<slug>.html: several
    // tools with genuinely different controls share one shell instead of growing conditional
    // blocks inside it, and the shell itself carries no tool-specific markup at all.
    const output = isLive
      ? render(
          toolTemplate,
          {
            ...shared,
            body: render(readTemplate(`tools/${tool.slug}.html`), shared, {
              file: `src/templates/tools/${tool.slug}.html`,
            }),
          },
          { file: 'src/templates/tool.template.html' },
        )
      : render(plannedTemplate, shared, { file: 'src/templates/tool-planned.template.html' });

    results.push(writeGenerated(pageFile(localeSite, code, path), output));
    audits.push({
      file: srcLabel(site.defaultLocale, code, path),
      placeholders: findPlaceholders(output),
    });
  }

  /* ---------- standalone pages ---------- */

  const pageTemplate = readTemplate('page.template.html');

  /*
   * The sentence itself lives in the catalogue, in both languages, and only the URL is substituted.
   * It used to be assembled here as one English string, which made it the one piece of the contact
   * page that could not be translated — and it was interpolated with `{{…}}` rather than `{{{…}}}`, so
   * the whole thing rendered as escaped markup: a paragraph of visible HTML source, unnoticed because
   * the placeholder audit still found the "TO CONFIRM" marker inside it.
   */
  const contactRepoLink = localeSite.contactRepo
    ? interpolate(catalog['ui.page.repoLink'], {
        url: escapeHtml(localeSite.contactRepo),
        label: escapeHtml(localeSite.contactRepo.replace(/^https?:\/\//, '')),
      })
    : catalog['ui.page.repoMissing'];

  for (const page of localePages) {
    const path = pagePath(page);
    const url = pageUrl(localeSite, code, path);
    const bodyFile = `pages/${page.slug}.html`;
    const shared = {
      banner,
      slug: page.slug,
      h1: page.h1,
      navLabel: page.navLabel,
      lastUpdated: page.lastUpdated,
      lastUpdatedLabel: formatIsoDate(page.lastUpdated, catalog),
      contactEmail: localeSite.contactEmail,
      contactRepoLink,
      // Only an advertised page is indexable. The offline fallback is a `utility` page: it is
      // generated, linked from the service worker and reachable, but it is not a search result.
      robots: page.status === 'live' ? '' : '  <meta name="robots" content="noindex, follow">',
      // Used by the offline page's body to list what still works there. Rendered from the same
      // tools list the homepage grid uses, so the two cannot disagree about which tools exist — and
      // with the locale's prefix, because an Arabic offline page whose cards link to the English
      // tools sends the visitor to a page in the other language.
      liveToolsHtml: liveToolsHtml(localeTools, strings, localePrefix),
    };

    const body = render(readLocaleTemplate(bodyFile, code, site.defaultLocale), shared, {
      file: `src/templates/${code === site.defaultLocale ? '' : `${code}/`}${bodyFile}`,
    });
    const output = render(
      pageTemplate,
      {
        ...shared,
        ...head(path),
        // After `head(path)`, because that sets the wrapper-carrying notice the homepage and the tool
        // pages want. This page's body is already inside a container, so its notice does not bring one.
        translationNotice: translationNoticeHtml(locale, catalog, site.defaultLocale, { container: false }),
        title: page.title,
        description: page.description,
        ogTags: ogTags(
          {
            title: page.title,
            description: page.description,
            url,
            imageUrl: ogImageUrl(localeSite, code, ogImageKey('page', page.slug)),
          },
          localeSite,
        ),
        jsonLd: jsonLdScript([
          breadcrumbList({
            url,
            items: [
              { name: catalog['ui.chrome.allTools'], url: pageUrl(localeSite, code, '/') },
              { name: page.navLabel, url },
            ],
          }),
        ]),
        adSlots: adSlotsHtml({ site: localeSite, place: 'below-content' }),
        body,
      },
      { file: 'src/templates/page.template.html' },
    );

    results.push(writeGenerated(pageFile(localeSite, code, path), output));
    audits.push({
      file: srcLabel(site.defaultLocale, code, path),
      placeholders: findPlaceholders(output),
    });
  }

  /* ---------- homepage ---------- */

  // Generated like everything else so its canonical, og:url, title and description all come from
  // content/site.json. While it was hand-written it was the one page whose origin could disagree
  // with the sitemap, robots.txt and every other page.
  const homeBody = render(readLocaleTemplate('home.html', code, site.defaultLocale), {}, {
    file: `src/templates/${code === site.defaultLocale ? '' : `${code}/`}home.html`,
  });
  const homeTitle = `${localeSite.name} — ${localeSite.tagline}`;
  const homeUrl = pageUrl(localeSite, code, '/');
  const homeHtml = render(
    readTemplate('site.template.html'),
    {
      banner,
      ...head('/'),
      title: homeTitle,
      description: localeSite.description,
      ogTags: ogTags(
        {
          title: homeTitle,
          description: localeSite.description,
          url: homeUrl,
          imageUrl: ogImageUrl(localeSite, code, ogImageKey('home')),
          imageAlt: `${localeSite.name} — ${localeSite.tagline}`,
        },
        localeSite,
      ),
      // No SearchAction: there is no site search, and a potentialAction pointing at an endpoint
      // that does not exist would be a machine-readable lie.
      jsonLd: jsonLdScript([
        webSite({ site: localeSite, lang, homeUrl, description: localeSite.description }),
        organization({
          site: localeSite,
          logoUrl: ogImageUrl(localeSite, code, ogImageKey('home')),
          homeUrl,
        }),
      ]),
      adSlots: adSlotsHtml({ site: localeSite, place: 'below-content' }),
      body: homeBody,
    },
    { file: 'src/templates/site.template.html' },
  );

  results.push(writeGenerated(pageFile(localeSite, code, '/'), homeHtml));
  audits.push({
    file: srcLabel(site.defaultLocale, code, '/'),
    placeholders: findPlaceholders(homeHtml),
  });
}

/* ---------- partials, one set per locale ---------- */

// Written to src/partials/<code>/ for a non-default locale, because the include path in a generated
// page names the directory it wants: `<!--#include partials/ar/nav-tools.html-->`. The hand-written
// chrome (header, footer, theme-boot) keeps its copies in the same place, so a translator has one
// directory to look in for everything that language's chrome says.
for (const locale of site.locales) {
  const code = locale.code;
  const prefix = code === site.defaultLocale ? '' : `${code}/`;
  const partial = (name) => resolve(srcDir, 'partials', `${prefix}${name}`);
  const localeTools = loadTools(code);
  const strings = chromeStrings(loadUi(code));
  results.push(writeGenerated(partial('tool-grid.html'), toolGridPartial(localeTools, code, strings)));
  results.push(writeGenerated(partial('nav-tools.html'), navToolsPartial(localeTools, code)));
  results.push(
    writeGenerated(partial('nav-pages.html'), navPagesPartial({ place: 'footer', pageList: loadPages(code), code })),
  );
  results.push(
    writeGenerated(
      partial('nav-header-pages.html'),
      navPagesPartial({ place: 'header', pageList: loadPages(code), code }),
    ),
  );
}

reportWrites(results, { prefix: 'build-pages' });
reportPlaceholders(audits, { prefix: 'build-pages' });
