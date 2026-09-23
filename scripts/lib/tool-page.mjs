/**
 * The tool-page rendering kit: every piece of markup that a live tool page and a target landing
 * page both need, defined exactly once.
 *
 * This exists because a target page is not a new kind of page — it is the parent tool's own page
 * with a different head, a different intro, a pre-set default and a body of content. Both
 * generators therefore render the same `src/templates/tools/<slug>.html` fragment through these
 * functions, so a card, a config block or an FAQ item can never drift between the two.
 *
 * Nothing here reads content/ or touches the filesystem: every function is a pure function of its
 * arguments, which is what lets tests/content.test.js and tests/targets.test.js check the output
 * shape without a build.
 */
import { MARGINS, PAGE_SIZES, QUALITIES } from '../../src/assets/js/core/engine-pdf.js';
import { CROP_RATIOS, RESIZE_PRESETS } from '../../src/assets/js/core/presets.js';
import { alternateLinks, localePath, localePublishes, pageUrl, targetPath, toolPath } from './content.mjs';
import { escapeHtml, interpolate } from './render.mjs';

/** The one size every social card is generated at. */
export const OG_SIZE = { width: 1200, height: 630 };

/**
 * The catalogue keys the shared markup helpers need, pulled out of a locale's string map.
 *
 * Lives here rather than in a generator because both generators need it: build-pages.mjs renders
 * tool and standalone pages, build-targets.mjs renders the same panel fragments inside target
 * pages. Two copies would be two chances for a target page to say "Related tools" while its
 * parent said something else.
 */
export function chromeStrings(catalog) {
  return {
    faqHeading: catalog['ui.shell.faqHeading'],
    relatedHeading: catalog['ui.shell.relatedHeading'],
    guidesHeading: catalog['ui.shell.guidesHeading'],
    comingSoon: catalog['ui.shell.comingSoon'],
    noLiveTools: catalog['ui.shell.noLiveTools'],
    conjunction: catalog['ui.shell.listOr'],
    // The separator between list items, not just the conjunction before the last: Arabic separates
    // with `،`, and a Latin comma inside an Arabic hint is the small wrong mark a reader notices.
    separator: catalog['ui.shell.listSeparator'],
    unit: catalog['ui.shell.mb'],
    // `acceptHint` needs the sentence around the format list and the size. Without it the helper
    // falls back to its own English template, which shipped "JPEG وPNG وWebP up to 50 ميجابايت" on
    // the Arabic pages until this key was added — the catalogue entry existed and nothing read it.
    template: catalog['ui.shell.acceptHint'],
  };
}

/**
 * Social-card naming. One file per page, keyed by page kind, so `gen-og.mjs` and the two page
 * generators cannot disagree about which image belongs to which URL — they both call these.
 */
export function ogImageKey(kind, slug = null) {
  return slug ? `${kind}-${slug}` : kind;
}

export function ogImagePath(site, locale, key, extension = 'png') {
  const prefix = locale === site.defaultLocale ? '' : `${locale}/`;
  return `/${prefix}og/${key}.${extension}`;
}

/**
 * Absolute URL of a card. Locale-aware for the same reason the routes are: an Arabic page must not
 * advertise an English share image, so non-default locales get their own file under /<locale>/og/.
 */
export function ogImageUrl(site, locale, key, extension = 'png') {
  return `${site.url}${ogImagePath(site, locale, key, extension)}`;
}

export const MIME_LABELS = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
  'image/gif': 'GIF',
  'application/pdf': 'PDF',
};

export const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

export function label(mime) {
  return MIME_LABELS[mime] ?? mime.split('/').pop().toUpperCase();
}

/** `"JPEG, PNG or WebP"` — the conjunction is a word, so it is passed in, not compiled in. */
export function listPhrase(items, conjunction = 'or', separator = ',') {
  if (items.length <= 1) return items[0] ?? '';
  // The catalogue holds the *punctuation* only (`،` in Arabic, `,` in English) and the single space
  // is added here, because `validateUi()` trims every value: a catalogue entry ending in a space
  // cannot survive loading, so a separator that had to carry its own space would silently lose it.
  return `${items.slice(0, -1).join(`${separator} `)} ${conjunction} ${items[items.length - 1]}`;
}

export function fileSizeLabel(bytes, unit = 'MB') {
  const megabytes = bytes / (1024 * 1024);
  const rounded = Number.isInteger(megabytes) ? String(megabytes) : megabytes.toFixed(1);
  return `${rounded} ${unit}`;
}

/**
 * "JPEG, PNG or WebP up to 50 MB" / "JPEG وPNG وWebP حتى 50 ميجابايت".
 *
 * Assembled from the catalogue because word order and conjunctions are not universal: Arabic joins
 * list items with a prefix on each word rather than a word between them. The numbers stay Western
 * digits in both languages, and rtl.css isolates them so they cannot reorder.
 */
export function acceptHint(tool, strings = {}) {
  const formats = listPhrase(tool.accepts.map(label), strings.conjunction, strings.separator);
  const size = fileSizeLabel(tool.maxInputBytes, strings.unit);
  return interpolate(strings.template ?? '{formats} up to {size}', { formats, size });
}

/**
 * The right-to-left stylesheet, linked only where it applies.
 *
 * Neither the base nor the component stylesheet mentions direction, so rtl.css is the whole of the
 * RTL layer and it is fetched by Arabic pages alone — an English visitor downloads nothing extra for
 * a language they are not reading.
 */
export function rtlHeadHtml(locale) {
  return locale.dir === 'rtl' ? '  <link rel="stylesheet" href="/assets/css/rtl.css">' : '';
}

/**
 * The runtime string block: the `js.` half of the catalogue, embedded in the page.
 *
 * Inline rather than a fetched file so there is no request between first paint and ready text, and
 * so a page that is already loaded works offline with its own strings — which is what the service
 * worker's offline story depends on.
 */
export function uiStringsBlock(runtime) {
  return JSON.stringify(runtime, null, 2).replace(/</g, '\\u003c');
}

/**
 * The disclosure that a page's Arabic is machine-written and unreviewed.
 *
 * Empty for the default locale, so nothing changes on the English pages, and required on every other
 * locale's pages by scripts/audit-seo.mjs — the phase that added translations is the phase that has
 * to say out loud they have not been reviewed.
 */
export function translationNoticeHtml(locale, catalog, defaultLocale, { container = true } = {}) {
  if (locale.code === defaultLocale) return '';
  const text = catalog['ui.chrome.translationNotice'] ?? '';
  if (text === '') return '';
  // `container: false` is for a page whose body is already inside one — a standalone page's notice
  // sits in the page's own container, and nesting a second one would double the horizontal inset.
  if (!container) return `  <p class="translation-notice" role="note" lang="${locale.code}">${escapeHtml(text)}</p>`;
  return `  <div class="container">\n    <p class="translation-notice" role="note" lang="${locale.code}">${escapeHtml(text)}</p>\n  </div>`;
}

/**
 * Open Graph + Twitter cards for one page.
 *
 * The width/height/alt tags are not decoration: Google's March 2026 image guidance uses `og:image`
 * as a source for Search and Discover thumbnails, and a declared size is what stops a crawler
 * guessing. `imageUrl` must already be absolute — every caller builds it with `ogImageUrl`.
 */
export function ogTags({ title, description, url, imageUrl, imageAlt, type = 'website' }, site) {
  const alt = imageAlt ?? title;
  return [
    `  <meta property="og:type" content="${type}">`,
    `  <meta property="og:site_name" content="${escapeHtml(site.name)}">`,
    `  <meta property="og:title" content="${escapeHtml(title)}">`,
    `  <meta property="og:description" content="${escapeHtml(description)}">`,
    `  <meta property="og:url" content="${url}">`,
    `  <meta property="og:image" content="${imageUrl}">`,
    `  <meta property="og:image:width" content="${OG_SIZE.width}">`,
    `  <meta property="og:image:height" content="${OG_SIZE.height}">`,
    `  <meta property="og:image:alt" content="${escapeHtml(alt)}">`,
    `  <meta name="twitter:card" content="summary_large_image">`,
    `  <meta name="twitter:title" content="${escapeHtml(title)}">`,
    `  <meta name="twitter:description" content="${escapeHtml(description)}">`,
    `  <meta name="twitter:image" content="${imageUrl}">`,
    `  <meta name="twitter:image:alt" content="${escapeHtml(alt)}">`,
  ].join('\n');
}

/**
 * Social tags for a tool page, in the page's own locale.
 *
 * Every URL here carries the locale prefix: an Arabic page that advertises the English `og:url` and
 * the English share image is telling social platforms to show the wrong page, and a crawler to
 * index the wrong language against it. The alt text comes from the catalogue rather than being
 * assembled in English, because it is read aloud by screen readers on the card.
 */
export function toolOgTags(tool, site, code = null, imageAlt = null) {
  const locale = code ?? site.defaultLocale;
  return ogTags(
    {
      title: tool.title,
      description: tool.description,
      url: pageUrl(site, locale, toolPath(tool)),
      imageUrl: ogImageUrl(site, locale, ogImageKey('tool', tool.slug)),
      imageAlt: imageAlt ?? `${tool.name} — a free tool that runs entirely in your browser`,
    },
    site,
  );
}

export function targetOgTags(target, site, code = null) {
  // Locale-aware for the same reason `toolOgTags` is: an Arabic guide page that advertises the
  // English canonical or the English card is a page telling a crawler it is something else.
  const locale = code ?? site.defaultLocale;
  return ogTags(
    {
      title: target.title,
      description: target.description,
      url: pageUrl(site, locale, targetPath(target)),
      imageUrl: ogImageUrl(site, locale, ogImageKey('guide', target.slug)),
      imageAlt: target.title,
      type: 'article',
    },
    site,
  );
}

/**
 * `<link rel="alternate" hreflang>` for every configured locale plus `x-default`.
 *
 * With one locale this is a self-referencing `en` plus `x-default`, which is valid and needs no
 * change when a second language lands — the list comes from content/site.json, not from here.
 */
export function alternatesHtml(site, path) {
  return alternateLinks(site, path)
    .map(({ hreflang, href }) => `  <link rel="alternate" hreflang="${hreflang}" href="${href}">`)
    .join('\n');
}

/**
 * A reserved advertising slot, or nothing at all.
 *
 * `site.ads` is false today, so no markup is emitted and CLS stays 0 because there is nothing to
 * shift. Turning the flag on emits a box whose height is already reserved by the `.ad-slot`
 * contract in components.css, so wiring an ad network later cannot move the page either. Slots sit
 * below the tool panel and inside the prose on purpose: nothing reserved can become the LCP image.
 */
export function adSlotsHtml({ site, place }) {
  if (!site.ads) return '';
  const size = place === 'in-article' ? 'rectangle' : 'leaderboard';
  return `  <aside class="ad-slot ad-slot-${size}" data-ad-slot="${place}" aria-label="Advertisement"></aside>`;
}

/** Semantic FAQ markup with stable hooks; the JSON-LD layer arrives in a later phase. */
export function faqHtml(entry, strings = {}) {
  const heading = strings.faqHeading ?? 'Frequently asked questions';
  if (entry.faq.length === 0) return '';
  const items = entry.faq
    .map(
      (item) =>
        `    <details class="faq-item" data-faq-item>\n      <summary>${escapeHtml(item.q)}</summary>\n      <p>${escapeHtml(item.a)}</p>\n    </details>`,
    )
    .join('\n');
  return secondarySection({ className: 'faq', heading, attributes: 'data-faq', body: items });
}

/**
 * Runtime configuration for the tool's own script, injected as JSON in the page.
 *
 * `defaults` is how a target page arrives pre-configured: the parent tool's script reads the same
 * keys off the same block, so there is one config contract for both page kinds. It is omitted
 * entirely when absent, which is what keeps a tool page's block byte-identical to before targets
 * existed.
 */
export function toolConfig(tool, { defaults = null } = {}) {
  const config = {
    slug: tool.slug,
    name: tool.name,
    accepts: tool.accepts,
    outputs: tool.outputs,
    defaultOutput: tool.defaultOutput,
    maxInputBytes: tool.maxInputBytes,
    outputLabels: Object.fromEntries(tool.outputs.map((mime) => [mime, label(mime)])),
    outputExtensions: Object.fromEntries(
      tool.outputs.map((mime) => [mime, MIME_EXTENSIONS[mime] ?? 'img']),
    ),
  };
  if (defaults) config.defaults = defaults;

  // Weights a tool downloads at runtime. Present only for tools that have any, so a page that does
  // not use a model stays byte-identical to before models existed — the same reason `defaults`
  // above is conditional. The URL, exact byte count and licence all come from content/tools.json
  // rather than being repeated here, and tests/models.test.js checks them against
  // LICENSES-THIRD-PARTY.md so the two cannot drift.
  if (tool.models.length > 0) {
    config.models = Object.fromEntries(
      tool.models.map((model) => [
        model.id,
        {
          name: model.name,
          purpose: model.purpose,
          url: model.url,
          bytes: model.bytes,
          license: model.license,
          licenseUrl: model.licenseUrl,
          sourceUrl: model.sourceUrl,
          sha256: model.sha256,
        },
      ]),
    );
  }

  return JSON.stringify(config, null, 2).replace(/</g, '\\u003c');
}

export function indentLines(text, indent) {
  if (!indent) return text;
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? line : `${indent}${line}`))
    .join('\n');
}

/** The tool card, used by the homepage grid and by the live-tools list on a planned page. */
/**
 * `prefix` is the locale's URL prefix (`''` for the default locale, `'/ar'` for another).
 *
 * It is an argument rather than something derived here because a card is rendered while a specific
 * locale's page is being generated, and a card that ignores it links an Arabic visitor to the English
 * tool — the exact mixed-language page the audit rejects.
 */
export function toolCard(item, { badge = false, indent = '', strings = {}, prefix = '' } = {}) {
  const lines = [
    '  <li class="' + (badge ? 'tool-card tool-card-planned' : 'tool-card') + '" data-category="' + escapeHtml(item.category ?? 'other') + '">',
    '    <a class="tool-card-link" href="' + prefix + toolPath(item) + '">',
    '      <span class="tool-card-name">' + escapeHtml(item.cardName ?? item.name) + '</span>',
    '      <span class="tool-card-desc">' + escapeHtml(item.cardSubtitle ?? item.description) + '</span>',
  ];
  if (badge) lines.push('      <span class="tool-card-badge">' + escapeHtml(strings.comingSoon ?? 'Coming soon') + '</span>');
  lines.push('    </a>');
  if (!badge) {
    lines.push('    <button class="tool-favorite" type="button" data-favorite-toggle="' + escapeHtml(item.slug) + '" aria-pressed="false" hidden>☆</button>');
  }
  lines.push('  </li>');
  return indentLines(lines.join('\n'), indent);
}

/** A card for a target landing page, using its short nav label rather than its full title. */
export function guideCard(target, { indent = '', prefix = '' } = {}) {
  const lines = [
    '  <li class="tool-card">',
    `    <a class="tool-card-link" href="${prefix}${targetPath(target)}">`,
    `      <span class="tool-card-name">${escapeHtml(target.navLabel)}</span>`,
    `      <span class="tool-card-desc">${escapeHtml(target.description)}</span>`,
    '    </a>',
    '  </li>',
  ];
  return indentLines(lines.join('\n'), indent);
}

/**
 * A secondary section: a real `<details>` disclosure that is collapsed on a phone and laid out flat
 * on a desktop.
 *
 * **Closed by default in the markup, expanded by CSS on wide screens, with no JavaScript.** Marking
 * them `open` and collapsing them on mobile cannot be done in CSS at all; so the default state is
 * the cheap one (collapsed) and the desktop rule in `components.css` lays the body out anyway.
 *
 * **Why the body is a sibling of the `<details>` rather than a child.** The first attempt put the
 * prose inside the disclosure and tried to beat the user agent with author CSS. That works in no
 * engine shipped today: Chrome reveals `::details-content` only from 131, and before that the UA
 * hides a closed disclosure's content inside an anonymous box that no selector can reach, with a
 * specificity the author sheet cannot outrank. On a desktop that rendered as a heading with 46px of
 * nothing under it. Moving the body out makes the reveal an ordinary `display` rule over an ordinary
 * sibling, which every engine that can render the page understands.
 *
 * Consequences worth knowing before editing this: the `<section>` keeps the class the block already
 * had (`tool-notes`, `faq`, `related-tools`), so every existing descendant rule still matches — but
 * the `<h2>` now sits inside the `<details>`, so a rule written as `.tool-notes > h2` would need
 * `summary h2` instead. The `<details>` wraps only the summary and is empty otherwise; its job is to
 * carry the `open` state and the disclosure semantics.
 */
export function secondarySection({ className, heading, body, attributes = '' }) {
  const attrs = attributes ? ` ${attributes}` : '';
  return [
    `  <section class="secondary-section ${className}"${attrs} data-collapsible>`,
    `    <details><summary><h2>${escapeHtml(heading)}</h2></summary></details>`,
    '    <div class="disclosure-body">',
    indentLines(body, '  '),
    '    </div>',
    '  </section>',
  ].join('\n');
}

/**
 * The generated internal-link block. It appears on a tool page (every target's parent) and on each
 * target page (its siblings), so a target is reachable by crawling rather than only via the
 * sitemap.
 */
export function guidesHtml(targets, { heading, prefix = '' }) {
  if (targets.length === 0) return '';
  const cards = targets.map((target) => guideCard(target, { indent: '    ', prefix })).join('\n');
  return secondarySection({
    className: 'related-tools',
    heading,
    attributes: 'data-guides',
    body: `    <ul class="tool-grid">\n${cards}\n    </ul>`,
  });
}

/**
 * The English phrasing of a pre-set summary.
 *
 * This is the default argument to `describeDefaultOption()`, and it is byte-for-byte what that
 * function used to hardcode — the option labels come from the constants in `presets.js` and
 * `engine-pdf.js` rather than from the catalogue, so an English page cannot move when the
 * catalogue is reworded. A translated locale passes `optionStrings(catalog)` instead; for English
 * the two would agree anyway, because every `js.pdf.*.label` / `js.preset.*` / `js.ratio.*.label`
 * value is identical to its constant.
 */
const OPTION_PHRASES = Object.freeze({
  preset: '{label} preset ({width} × {height} px)',
  pixels: '{width} × {height} pixels',
  targetSize: 'a {size} KB target file size per image',
  output: '{label} output',
  ratio: '{label} aspect ratio',
  pageSize: '{label} page size',
  marginNone: 'no page margins',
  margin: '{label} page margins',
  quality: '{label}',
  fallback: 'the suggested settings',
});

/**
 * The separator, kept out of the phrase list because it is shared with the accept hint.
 *
 * It is punctuation only — `,` in English, `،` in Arabic — for the reason `listPhrase()` documents:
 * `validateUi()` trims every catalogue value, so a separator carrying its own trailing space would
 * silently lose it on load. The space is added where the join happens.
 */
const ENGLISH_SEPARATOR = ',';

/** The default argument: the English phrases with the English separator. */
const ENGLISH_OPTIONS = Object.freeze({ ...OPTION_PHRASES, separator: ENGLISH_SEPARATOR });

/**
 * The catalogue keys `describeDefaultOption()` needs, in the same shape as `chromeStrings()`.
 *
 * The option *labels* come from the same keys the tool panels already use at run time
 * (`js.preset.<id>`, `js.ratio.<id>.label`, `js.pdf.pageSize.<id>.label`, …), so a preset cannot be
 * called one thing in the dropdown and another in the "pre-set for you" sentence above it.
 *
 * Each label lookup returns `undefined` for a key the catalogue does not have, which sends that one
 * label back to its English constant instead of printing `js.pdf.margin.normal.label` on the page.
 */
export function optionStrings(catalog = {}) {
  const phrase = (name) => {
    const key = `ui.target.option.${name}`;
    return typeof catalog[key] === 'string' ? catalog[key] : ENGLISH_OPTIONS[name];
  };
  return {
    // Read from the same key the accept hints use: one punctuation mark per locale, not two.
    separator: typeof catalog['ui.shell.listSeparator'] === 'string' ? catalog['ui.shell.listSeparator'] : ENGLISH_SEPARATOR,
    preset: phrase('preset'),
    pixels: phrase('pixels'),
    targetSize: phrase('targetSize'),
    output: phrase('output'),
    ratio: phrase('ratio'),
    pageSize: phrase('pageSize'),
    marginNone: phrase('marginNone'),
    margin: phrase('margin'),
    quality: phrase('quality'),
    fallback: phrase('fallback'),
    presetLabel: (id) => catalog[`js.preset.${id}`],
    ratioLabel: (id) => catalog[`js.ratio.${id}.label`],
    pageSizeLabel: (id) => catalog[`js.pdf.pageSize.${id}.label`],
    marginLabel: (id) => catalog[`js.pdf.margin.${id}.label`],
    qualityLabel: (id) => catalog[`js.pdf.quality.${id}.label`],
  };
}

/** Every catalogue key a pre-set summary is built from, derived from the English defaults above. */
export const OPTION_STRING_KEYS = Object.freeze(
  Object.keys(OPTION_PHRASES).map((name) => `ui.target.option.${name}`),
);

/**
 * The option phrases a locale's catalogue does not have.
 *
 * Exported so a generator can refuse to publish a target page in a language whose summary would
 * silently fall back to English — the failure mode this project has already shipped twice
 * (`acceptHint`'s template, and the raw `js.` keys of Phase 8). `tests/targets.test.js` also
 * asserts this is empty for every configured locale, so the check cannot rot.
 */
export function missingOptionStrings(catalog = {}) {
  return OPTION_STRING_KEYS.filter(
    (key) => typeof catalog[key] !== 'string' || catalog[key].trim() === '',
  );
}

/**
 * A target page states what it came pre-configured with, so a visitor can see at a glance what the
 * page is for — and that the setting is a starting point, not a lock.
 *
 * The ids were already validated against these same lists when the content was loaded, so an
 * unknown one cannot reach here; the fallbacks below only keep a phrasing from coming out empty.
 */
export function describeDefaultOption(defaultOption, strings = ENGLISH_OPTIONS) {
  const parts = [];
  // A label is a catalogue string when the locale has one, and the English constant otherwise.
  const nameOf = (lookup, id, fallback) => (typeof lookup === 'function' ? lookup(id) : undefined) ?? fallback;

  if (defaultOption.presetId) {
    const preset = RESIZE_PRESETS.find((entry) => entry.id === defaultOption.presetId);
    if (preset) {
      parts.push(
        interpolate(strings.preset, {
          label: nameOf(strings.presetLabel, preset.id, preset.label),
          width: preset.width,
          height: preset.height,
        }),
      );
    }
  }
  if (defaultOption.width !== undefined || defaultOption.height !== undefined) {
    const width = defaultOption.width ?? 'auto';
    const height = defaultOption.height ?? 'auto';
    parts.push(interpolate(strings.pixels, { width, height }));
  }
  if (defaultOption.targetSizeKB !== undefined) {
    parts.push(interpolate(strings.targetSize, { size: defaultOption.targetSizeKB }));
  }
  if (defaultOption.outputMime) {
    parts.push(interpolate(strings.output, { label: label(defaultOption.outputMime) }));
  }

  if (defaultOption.ratioId) {
    const ratio = CROP_RATIOS.find((entry) => entry.id === defaultOption.ratioId);
    if (ratio) parts.push(interpolate(strings.ratio, { label: nameOf(strings.ratioLabel, ratio.id, ratio.label) }));
  }
  if (defaultOption.pageSizeId) {
    const size = PAGE_SIZES.find((entry) => entry.id === defaultOption.pageSizeId);
    if (size) {
      parts.push(interpolate(strings.pageSize, { label: nameOf(strings.pageSizeLabel, size.id, size.label) }));
    }
  }
  if (defaultOption.marginId) {
    const margin = MARGINS.find((entry) => entry.id === defaultOption.marginId);
    if (margin) {
      // "None margins" is not English, so the empty case gets its own phrasing. The label is
      // lowercased because the English sentence reads "normal (0.5 in) page margins" mid-sentence;
      // lowercasing an Arabic label is a no-op, so one line serves both locales.
      const marginName = nameOf(strings.marginLabel, margin.id, margin.label).toLowerCase();
      parts.push(
        margin.id === 'none' ? strings.marginNone : interpolate(strings.margin, { label: marginName }),
      );
    }
  }
  if (defaultOption.qualityId) {
    const quality = QUALITIES.find((entry) => entry.id === defaultOption.qualityId);
    // The label already says what it means ("Balanced (JPEG 85%)"), so it is not decorated further.
    if (quality) {
      parts.push(
        interpolate(strings.quality, {
          label: nameOf(strings.qualityLabel, quality.id, quality.label),
        }),
      );
    }
  }

  return parts.length > 0 ? parts.join(`${strings.separator} `) : strings.fallback;
}

/**
 * Renders parsed uniqueContent blocks. Text is escaped, never trusted: the content is prose, and a
 * stray angle bracket in it should be a visible typo rather than markup.
 */
export function uniqueContentHtml(blocks) {
  const parts = blocks.map((block) => {
    if (block.type === 'h2') return `    <h2>${escapeHtml(block.text)}</h2>`;
    if (block.type === 'ul') {
      const items = block.items.map((item) => `      <li>${escapeHtml(item)}</li>`).join('\n');
      return `    <ul>\n${items}\n    </ul>`;
    }
    return `    <p>${escapeHtml(block.text)}</p>`;
  });
  return `  <section class="prose" data-unique-content>\n${parts.join('\n')}\n  </section>`;
}

