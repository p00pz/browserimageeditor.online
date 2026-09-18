#!/usr/bin/env node
/**
 * Generates the long-tail landing pages from content/targets.json.
 *
 * A target page is a **working** tool page for one narrow query. It renders the parent tool's own
 * panel — the same `src/templates/tools/<parent-slug>.html` fragment the tool page renders — and
 * passes the target's `defaultOption` through the same `#tool-config` block that tool's script
 * already reads. So "/targets/compress-image-to-100kb/" is the real compressor with 100 KB already
 * in the box: not a copy of the UI, and not a link to somewhere else.
 *
 * The content gate is deliberately hard. Every target must carry at least MIN_UNIQUE_WORDS of prose
 * that appears nowhere else on the site, and a live target must contain no unresolved [VERIFY]
 * marker. Either failure exits non-zero naming the entry, before anything is written — a target
 * page that is a near-copy of its tool page is worse than no page at all.
 *
 * A target whose status is "planned" is a parked draft: it is reported, and no page is generated.
 * Every live target is generated once per configured locale, with its own canonical and alternates.
 *
 * Output:
 *   src/targets/<slug>/index.html
 *   src/<locale>/targets/<slug>/index.html
 */
import {
  MIN_UNIQUE_WORDS,
  loadSite,
  loadTargets,
  loadTools,
  loadUi,
  localePath,
  markupStrings,
  pageFile,
  pageUrl,
  partialsPrefix,
  runtimeStrings,
  targetPath,
  toolPath,
} from './lib/content.mjs';
import {
  findPlaceholders,
  generatedBanner,
  interpolate,
  readTemplate,
  render,
  reportPlaceholders,
  reportWrites,
  writeGenerated,
} from './lib/render.mjs';
import { breadcrumbList, faqPage, jsonLdScript } from './lib/schema.mjs';
import { pwaHeadHtml } from './lib/pwa.mjs';
import {
  acceptHint,
  adSlotsHtml,
  alternatesHtml,
  chromeStrings,
  describeDefaultOption,
  missingOptionStrings,
  optionStrings,
  faqHtml,
  guidesHtml,
  langSwitchHtml,
  rtlHeadHtml,
  targetOgTags,
  toolConfig,
  translationNoticeHtml,
  uiStringsBlock,
  uniqueContentHtml,
} from './lib/tool-page.mjs';

const BY = 'scripts/build-targets.mjs';
const FROM = 'content/targets.json';

const site = loadSite();
const tools = loadTools();
const targets = loadTargets(tools);
const liveTargets = targets.filter((target) => target.status === 'live');
const parkedTargets = targets.filter((target) => target.status !== 'live');
const banner = generatedBanner({ by: BY, from: FROM });

/**
 * One rendered fragment per parent tool, cached: several targets share a parent, and rendering the
 * same fragment repeatedly would only risk the pages disagreeing with each other.
 *
 * Keyed by locale *and* slug, because a panel's words come from that locale's catalogue — one
 * locale's fragment handed to another locale's page is the exact bug this cache would otherwise
 * introduce the moment a second language publishes a target.
 */
const panelCache = new Map();

function toolPanelFor(tool, code, shared) {
  const key = `${code}:${tool.slug}`;
  if (!panelCache.has(key)) {
    panelCache.set(
      key,
      render(
        readTemplate(`tools/${tool.slug}.html`),
        {
          ...shared,
          slug: tool.slug,
          acceptAttr: tool.accepts.join(','),
          acceptHint: acceptHint(tool, shared.strings),
          dropzoneHint: interpolate(shared['t.ui.tool.dropzoneHint'], {
            acceptHint: acceptHint(tool, shared.strings),
          }),
        },
        { file: `src/templates/tools/${tool.slug}.html` },
      ),
    );
  }
  return panelCache.get(key);
}

/** The path of a generated file, as reported in the audit list. */
function srcLabel(defaultLocale, locale, path) {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const prefix = locale === defaultLocale ? '' : `${locale}/`;
  return `src/${prefix}${clean === '' ? '' : `${clean}/`}index.html`;
}

const results = [];
const audits = [];
const template = readTemplate('target.template.html');

for (const locale of site.locales) {
  const code = locale.code;
  const localeSite = loadSite(code);
  const localeTools = loadTools(code);
  const localeTargets = loadTargets(localeTools, code).filter((target) => target.status === 'live');
  const toolById = new Map(localeTools.map((tool) => [tool.id, tool]));
  const catalog = loadUi(code);
  const strings = chromeStrings(catalog);

  /**
   * A translated target page needs its own copy *and* its own option phrases, and this is where
   * both stop being assumptions.
   *
   * The copy half is already enforced: `loadTargets(locale)` publishes a target only when
   * content/<locale>/targets.json translates every field the English entry uses, FAQ items included.
   *
   * The other half is the "pre-set for you" sentence, which is assembled from catalogue phrases at
   * build time. A phrase a locale does not have falls back to its English wording, which would put a
   * sentence like "a 100 KB target file size per image" inside Arabic prose. Nothing else in the
   * build can see that, so it is checked here and fails by name.
   */
  if (code !== site.defaultLocale && localeTargets.length > 0) {
    const missing = missingOptionStrings(catalog);
    if (missing.length > 0) {
      throw new Error(
        `build-targets: "${code}" publishes ${localeTargets.length} target page(s), but content/${code}/ui.json is missing ${missing.length} option phrase(s): ${missing.join(', ')}. Without them a translated page's pre-set summary renders in English.`,
      );
    }
  }

  /**
   * Head values every page kind shares — the same block build-pages.mjs composes, for the same
   * reasons. Path-dependent pieces (canonical, alternates, the language switcher's target) are
   * added per page inside the loop below.
   */
  const shared = {
    lang: code,
    dir: locale.dir,
    siteName: localeSite.name,
    pwaHead: pwaHeadHtml(localeSite),
    rtlHead: rtlHeadHtml(locale),
    translationNotice: translationNoticeHtml(locale, catalog, site.defaultLocale),
    uiStrings: uiStringsBlock(runtimeStrings(catalog)),
    partials: partialsPrefix(site, code),
    homeHref: localePath(localeSite, code, '/'),
    strings,
    ...markupStrings(catalog),
  };

  for (const target of localeTargets) {
    const parent = toolById.get(target.parentToolId);
    const path = targetPath(target);
    const url = pageUrl(localeSite, code, path);
    // Every other target of the same tool, so the pages link to each other instead of only to the
    // parent — a new target is then reachable by crawling, not just via the sitemap.
    const siblings = localeTargets.filter(
      (candidate) => candidate.parentToolId === target.parentToolId && candidate.slug !== target.slug,
    );

    const output = render(
      template,
      {
        ...shared,
        banner,
        title: target.title,
        description: target.description,
        canonical: url,
        alternates: alternatesHtml(localeSite, path),
        langSwitch: langSwitchHtml(localeSite, code, path, catalog),
        ogTags: targetOgTags(target, localeSite, code),
        jsonLd: jsonLdScript([
          target.faq.length > 0 ? faqPage({ url, faq: target.faq }) : null,
          breadcrumbList({
            url,
            items: [
              { name: catalog['ui.chrome.allTools'], url: `${localeSite.url}/` },
              { name: parent.name, url: pageUrl(localeSite, code, toolPath(parent)) },
              { name: target.navLabel, url },
            ],
          }),
        ]),
        navLabel: target.navLabel,
        h1: target.h1,
        intro: target.intro,
        presetHint: interpolate(catalog['ui.target.presetHint'], {
          summary: describeDefaultOption(target.defaultOption, optionStrings(catalog)),
        }),
        toolPanel: toolPanelFor(parent, code, shared),
        adSlots: adSlotsHtml({ site: localeSite, place: 'in-article' }),
        uniqueContentHtml: uniqueContentHtml(target.uniqueContentBlocks),
        guidesHtml: guidesHtml(siblings, {
          heading: interpolate(catalog['ui.shell.moreGuides'], { name: parent.name }),
          prefix: code === site.defaultLocale ? '' : `/${code}`,
        }),
        faqHtml: faqHtml(target, strings),
        parentToolName: parent.name,
        // Prefixed like every other internal link on a translated page: a link from an Arabic page
        // to the unprefixed English tool is the language switch the site audit flags by name.
        parentToolPath: localePath(localeSite, code, toolPath(parent)),
        parentToolIntro: parent.intro,
        parentCtaHeading: interpolate(catalog['ui.target.ctaHeading'], { name: parent.name }),
        parentCtaButton: interpolate(catalog['ui.target.ctaButton'], { name: parent.name }),
        toolConfig: toolConfig(parent, { defaults: target.defaultOption }),
        toolScript: `/assets/js/tools/${parent.slug}.js`,
      },
      { file: 'src/templates/target.template.html' },
    );

    results.push(writeGenerated(pageFile(localeSite, code, path), output));
    audits.push({
      file: srcLabel(site.defaultLocale, code, path),
      placeholders: findPlaceholders(output),
    });
  }
}

reportWrites(results, { prefix: 'build-targets' });

// The content gate's own report: what was published, how much unique content each page carries, and
// which entry it belongs to. Criterion 3 of phase 4 asks for exactly this list, so it is printed on
// every run rather than left to be reconstructed later.
const width = Math.max(0, ...liveTargets.map((target) => target.slug.length));
console.log(`build-targets: content gate passed (minimum ${MIN_UNIQUE_WORDS} words of unique content)`);
for (const target of liveTargets) {
  console.log(
    `  ${target.slug.padEnd(width)}  ${String(target.uniqueContentWords).padStart(4)} words  ${targetPath(target)}`,
  );
}

/**
 * Then the same report for every other locale, because the gate applies there too and a translated
 * entry's word count is otherwise invisible: the list above is the default locale's, and an Arabic
 * page that clears 250 words only by accident would never be seen to be close to the line.
 * `loadTargets(locale)` has already refused to return anything under the minimum by this point, so
 * this block is the evidence, not the gate.
 */
for (const locale of site.locales) {
  if (locale.code === site.defaultLocale) continue;
  const translated = loadTargets(loadTools(locale.code), locale.code).filter(
    (target) => target.status === 'live',
  );
  if (translated.length === 0) continue;
  console.log(
    `build-targets: "${locale.code}" content gate passed (minimum ${MIN_UNIQUE_WORDS} words of unique content)`,
  );
  for (const target of translated) {
    console.log(
      `  ${target.slug.padEnd(width)}  ${String(target.uniqueContentWords).padStart(4)} words  ${targetPath(target)}  [${locale.code}]`,
    );
  }
}
for (const target of parkedTargets) {
  console.log(
    `  ${target.slug.padEnd(width)}  ${String(target.uniqueContentWords).padStart(4)} words  parked ("status": "${target.status}") — no page generated`,
  );
}

reportPlaceholders(audits, { prefix: 'build-targets' });
