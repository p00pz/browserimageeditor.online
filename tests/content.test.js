/**
 * Content-layer tests. The validators are pure functions over parsed data, so every failure
 * mode can be checked here instead of by breaking a real content file and running the build.
 * Run with `npm test`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContentError,
  loadPages,
  loadSite,
  loadTargets,
  loadTools,
  loadUi,
  validatePages,
  validateSite,
  validateTargets,
  validateTools,
} from '../scripts/lib/content.mjs';
import { escapeHtml, findPlaceholders, render } from '../scripts/lib/render.mjs';

/**
 * Stand-in tool records for the target validator. It only reads `id`, `status` and `outputs`, so
 * these stay deliberately small — the tool schema has tests of its own.
 */
const TARGET_TOOLS = [
  { id: 'compress', status: 'live', outputs: ['image/webp', 'image/jpeg'] },
  { id: 'resize', status: 'live', outputs: ['image/webp', 'image/jpeg'] },
  { id: 'convert', status: 'live', outputs: ['image/webp', 'image/png', 'image/jpeg'] },
  { id: 'crop', status: 'live', outputs: ['image/webp'] },
  { id: 'image-to-pdf', status: 'live', outputs: ['application/pdf'] },
  { id: 'planned-tool', status: 'planned', outputs: ['image/webp'] },
];

/** Long enough to clear the content gate, so a test can shorten it deliberately. */
const LONG_CONTENT = Array.from(
  { length: 60 },
  (_, index) => `Sentence ${index + 1} describes this particular use case in wording of its own.`,
).join(' ');

/** A minimal valid target, so each test can break exactly one thing. */
function target(overrides = {}) {
  return {
    slug: 'compress-image-to-100kb',
    parentToolId: 'compress',
    status: 'live',
    navLabel: 'Compress to 100 KB',
    title: 'Compress an image to 100KB',
    description: 'Get an image under a fixed size limit.',
    h1: 'Compress an image to 100KB',
    intro: 'Sample intro.',
    targetKeyword: 'compress image to 100kb',
    keywords: ['compress image to 100kb'],
    defaultOption: { targetSizeKB: 100 },
    uniqueContent: LONG_CONTENT,
    ...overrides,
  };
}

/** A minimal valid tool, so each test can break exactly one thing. */
function tool(overrides = {}) {
  return {
    id: 'sample',
    slug: 'sample-tool',
    name: 'Sample Tool',
    navLabel: 'Sample',
    status: 'planned',
    category: 'optimize',
    title: 'Sample tool',
    description: 'A sample tool used by the tests.',
    h1: 'Sample tool',
    intro: 'Sample intro.',
    keywords: ['sample'],
    targetKeyword: 'sample',
    accepts: ['image/jpeg'],
    outputs: ['image/webp'],
    defaultOutput: 'image/webp',
    maxInputBytes: 1048576,
    related: [],
    faq: [],
    ...overrides,
  };
}

test('the real content files load', () => {
  const tools = loadTools();
  const pages = loadPages();
  const site = loadSite();

  const ids = tools.map((entry) => entry.id);
  assert.ok(ids.includes('compress'), 'the compress tool should be described by id');
  assert.ok(ids.includes('resize') && ids.includes('convert') && ids.includes('crop'));
  assert.ok(ids.includes('image-to-pdf'));

  const compress = tools.find((entry) => entry.id === 'compress');
  assert.equal(compress.status, 'live');
  assert.equal(compress.slug, 'compress-image', 'the slug is the URL and may differ from the id');
  assert.equal(compress.targetKeyword, 'compress image');

  assert.deepEqual(
    pages.map((page) => page.slug).sort(),
    ['about', 'contact', 'how-it-works', 'offline', 'privacy', 'terms'],
  );

  const about = pages.find((page) => page.id === 'about');
  assert.deepEqual(about.nav, ['header', 'footer'], 'About belongs in the header nav, the rest in the footer');
  assert.ok(
    pages.filter((page) => page.status === 'live' && page.id !== 'about').every((page) => page.nav.includes('footer')),
    'every live page should be reachable from the footer',
  );
  // A utility page ships without being advertised: the offline fallback is linked from nowhere,
  // because a visitor must not be able to navigate to "you are offline" while online.
  assert.deepEqual(pages.find((page) => page.id === 'offline').nav, []);
  assert.ok(
    pages.filter((page) => page.status === 'utility').every((page) => page.priority === 0),
    'a utility page is not a search result, so it carries no sitemap priority',
  );
  assert.ok(site.tagline.length > 5, 'the homepage title is built from the site tagline');
  assert.ok(site.contactEmail.includes('@'), 'a contact address must be configured, even a placeholder');
  // Two locales since Phase 8, and the whole of "which languages does this site publish" is this
  // one array: the generators, the sitemap, the audit and the service worker all read it.
  assert.equal(site.defaultLocale, 'en');
  assert.deepEqual(
    site.locales.map((locale) => locale.code),
    ['en', 'ar'],
    'adding or removing a language is a content/site.json change and nothing else',
  );
  const arabic = site.locales.find((locale) => locale.code === 'ar');
  assert.equal(arabic.dir, 'rtl', 'the RTL stylesheet is linked from this flag alone');
  assert.ok(
    site.locales.filter((locale) => locale.code !== site.defaultLocale).every((locale) => locale.dir),
    'every locale states its direction rather than leaving it to be guessed',
  );

  // The string catalogue is the other half of a locale: a language with no catalogue would render
  // every label in English, which the audit would then have to catch page by page.
  const catalog = loadUi();
  assert.ok(Object.keys(catalog).length > 100, 'the string catalogue covers the interface');
  assert.ok(
    site.locales.every((locale) => catalog[`ui.chrome.lang.${locale.code}`]),
    'every configured locale has a name in its own language for the switcher',
  );
});

test('targets reference their parent tool by id, never by slug', () => {
  const [parsed] = validateTargets([target()], TARGET_TOOLS);
  assert.equal(parsed.parentToolId, 'compress');

  // The whole point of the field name: a slug that looks valid is still refused, so renaming a
  // tool's URL cannot silently break the landing pages that point at it.
  assert.throws(
    () => validateTargets([target({ parentToolId: 'compress-image' })], TARGET_TOOLS),
    (error) =>
      error instanceof ContentError && /"parentToolId" \("compress-image"\) is not an id/.test(error.message),
  );
  assert.throws(() => validateTargets([target({ parentToolId: undefined })], TARGET_TOOLS), /"parentToolId" is required/);
  assert.throws(() => validateTargets([target({ parentToolId: 'Compress Image' })], TARGET_TOOLS), /must be lowercase kebab-case/);
  // Duplicate slugs are checked before duplicate keywords, so this names the slug problem.
  assert.throws(() => validateTargets([target(), target()], TARGET_TOOLS), /duplicate slug/);
  assert.throws(() => validateTargets({ not: 'an array' }, TARGET_TOOLS), /must be a JSON array/);
});

test('a target cannot point at a tool that has no working panel yet', () => {
  assert.throws(
    () => validateTargets([target({ parentToolId: 'planned-tool' })], TARGET_TOOLS),
    (error) => error instanceof ContentError && /is not a live tool/.test(error.message),
  );
});

test('the real targets file resolves against the real tool ids', () => {
  const tools = loadTools();
  const targets = loadTargets(tools);
  assert.deepEqual(validateTargets([], tools), [], 'an empty targets list is valid');
  for (const entry of targets) {
    assert.ok(
      tools.some((tool) => tool.id === entry.parentToolId),
      `target "${entry.slug}" must point at a real tool id`,
    );
  }
});

test('ids and slugs are validated separately, and both must be unique', () => {
  assert.throws(
    () => validateTools([tool(), tool({ slug: 'another-slug' })]),
    (error) => error instanceof ContentError && /duplicate id "sample"/.test(error.message),
  );
  assert.throws(
    () => validateTools([tool(), tool({ id: 'sample-two' })]),
    (error) => /duplicate slug/.test(error.message),
  );
});

test('related tools are resolved by id and must exist', () => {
  const tools = validateTools([tool({ id: 'one', slug: 'one' }), tool({ id: 'two', slug: 'two', related: ['one'] })]);
  assert.deepEqual(tools[1].related, ['one']);

  assert.throws(
    () => validateTools([tool({ related: ['does-not-exist'] })]),
    (error) => /unknown related tool id/.test(error.message),
  );
  assert.throws(
    () => validateTools([tool({ related: ['sample'] })]),
    (error) => /lists itself/.test(error.message),
  );
});

test('a tool that breaks the schema fails loudly, in one message', () => {
  const cases = [
    [{ targetKeyword: undefined }, /"targetKeyword" is required/],
    [{ id: 'Not Kebab' }, /"id" must be lowercase kebab-case/],
    [{ slug: 'Also-Bad' }, /"slug" must be lowercase kebab-case/],
    [{ status: 'almost-live' }, /"status" must be one of/],
    [{ defaultOutput: 'image/avif' }, /must be one of "outputs"/],
    [{ outputs: [] }, /must list at least one mime type/],
    [{ maxInputBytes: 0 }, /"maxInputBytes" is required and must be a positive integer/],
    [{ title: '   ' }, /"title" is required/],
    [{ keywords: ['ok', 2] }, /must be an array of strings/],
  ];

  for (const [overrides, expected] of cases) {
    assert.throws(
      () => validateTools([tool(overrides)]),
      (error) => error instanceof ContentError && expected.test(error.message),
      `expected a failure matching ${expected}`,
    );
  }
});

test('an empty tools list is refused rather than generating nothing', () => {
  assert.throws(() => validateTools([]), /at least one tool/);
  assert.throws(() => validateTools({ not: 'an array' }), /must be a JSON array/);
});

test('planned pages are validated with their route metadata', () => {
  const page = {
    id: 'privacy',
    slug: 'privacy',
    navLabel: 'Privacy',
    status: 'live',
    title: 'Privacy',
    description: 'Privacy policy.',
    h1: 'Privacy policy',
    lastUpdated: '2026-09-17',
  };
  const [parsed] = validatePages([page]);
  assert.equal(parsed.priority, 0.5, 'priority defaults to 0.5');
  assert.equal(parsed.lastUpdated, '2026-09-17');
  assert.deepEqual(parsed.nav, ['footer'], 'pages default to the footer nav');
  assert.deepEqual(validatePages([{ ...page, nav: ['header', 'footer'] }])[0].nav, ['header', 'footer']);
  assert.throws(() => validatePages([{ ...page, nav: ['sidebar'] }]), /must be "header" or "footer"/);

  assert.throws(() => validatePages([{ ...page, lastUpdated: '17 September 2026' }]), /must be an ISO date/);
  assert.throws(() => validatePages([{ ...page, priority: 2 }]), /between 0 and 1/);
  assert.throws(() => validatePages([page, { ...page, id: 'privacy-two' }]), /duplicate slug/);
});

test('site metadata is validated, including the tagline and contact fields', () => {
  const site = {
    name: 'ImageTools',
    shortName: 'ImageTools',
    themeColor: '#0366d6',
    themeColorDark: '#0d1117',
    backgroundColor: '#ffffff',
    tagline: 'Free image tools that never upload your files',
    url: 'https://example.com/',
    description: 'Description.',
    ogImage: '/og/home.png',
    contactEmail: 'hello@example.com',
    defaultLocale: 'en',
    locales: [{ code: 'en', label: 'English' }],
  };
  const parsed = validateSite(site);
  assert.equal(parsed.url, 'https://example.com', 'the trailing slash is normalised away');
  assert.equal(parsed.contactRepo, null);
  assert.equal(parsed.ads, false, 'ads default to off, so no slot renders until it is switched on');

  // The install metadata is validated here rather than in a hand-written manifest, which is what
  // keeps the installed app's name and colours from drifting away from the site's own.
  assert.equal(parsed.shortName, 'ImageTools');
  assert.equal(parsed.themeColor, '#0366d6');
  assert.equal(parsed.themeColorDark, '#0d1117');
  assert.equal(parsed.backgroundColor, '#ffffff');
  assert.throws(() => validateSite({ ...site, shortName: 'ImageTools Desktop' }), /12 characters or fewer/);
  assert.throws(() => validateSite({ ...site, shortName: undefined }), /"shortName" is required/);
  assert.throws(() => validateSite({ ...site, themeColor: '#fff' }), /six-digit hex colour/);
  assert.throws(() => validateSite({ ...site, themeColor: 'rebeccapurple' }), /six-digit hex colour/);
  assert.throws(() => validateSite({ ...site, backgroundColor: undefined }), /"backgroundColor" is required/);
  assert.deepEqual(parsed.locales, [{ code: 'en', label: 'English', dir: 'ltr' }], 'direction defaults to ltr');

  assert.equal(validateSite({ ...site, contactRepo: 'https://github.com/example/site' }).contactRepo, 'https://github.com/example/site');
  assert.equal(validateSite({ ...site, ads: true }).ads, true);
  assert.throws(() => validateSite({ ...site, url: 'example.com' }), /absolute http\(s\) origin/);
  assert.throws(() => validateSite({ ...site, ogImage: 'https://example.com/og.png' }), /root-relative/);
  assert.throws(() => validateSite({ ...site, contactRepo: 'github.com/example' }), /must be an absolute http\(s\) URL/);
  assert.throws(() => validateSite({ ...site, contactEmail: '' }), /"contactEmail" is required/);
  assert.throws(() => validateSite({ ...site, tagline: '   ' }), /"tagline" is required/);
  assert.throws(() => validateSite({ ...site, ads: 'yes' }), /"ads" must be true or false/);
});

test('a second locale is a config change, and the config is checked hard', () => {
  const site = {
    name: 'ImageTools',
    shortName: 'ImageTools',
    themeColor: '#0366d6',
    themeColorDark: '#0d1117',
    backgroundColor: '#ffffff',
    tagline: 'Free image tools',
    url: 'https://example.com',
    description: 'Description.',
    ogImage: '/og/home.png',
    contactEmail: 'hello@example.com',
    defaultLocale: 'en',
    locales: [{ code: 'en', label: 'English' }, { code: 'ar', label: 'Arabic', dir: 'rtl' }],
  };
  const parsed = validateSite(site);
  assert.equal(parsed.locales[1].dir, 'rtl');

  assert.throws(() => validateSite({ ...site, locales: [] }), /must list at least one language/);
  assert.throws(() => validateSite({ ...site, locales: undefined }), /locales: must be a JSON array/);
  assert.throws(() => validateSite({ ...site, defaultLocale: undefined }), /"defaultLocale" is required/);
  assert.throws(() => validateSite({ ...site, defaultLocale: 'fr' }), /must be one of the codes in "locales"/);
  assert.throws(() => validateSite({ ...site, locales: [{ code: 'english', label: 'English' }] }), /language tag such as/);
  assert.throws(() => validateSite({ ...site, locales: [{ code: 'en', label: 'English', dir: 'sideways' }] }), /must be "ltr" or "rtl"/);
  assert.throws(
    () => validateSite({ ...site, locales: [{ code: 'en', label: 'One' }, { code: 'en', label: 'Two' }] }),
    /duplicate locale code/,
  );
});

test('render() fails on a token with no value instead of shipping a blank', () => {
  assert.equal(render('<h1>{{title}}</h1>', { title: 'A & B' }), '<h1>A &amp; B</h1>');
  assert.equal(render('{{{html}}}', { html: '<b>bold</b>' }), '<b>bold</b>');
  assert.throws(() => render('<h1>{{missing}}</h1>', {}), /has no value/);
});

test('the placeholder audit finds markers and example domains, and nothing else', () => {
  assert.deepEqual(findPlaceholders('<p>All good here.</p>'), []);

  const found = findPlaceholders(
    '<p class="page-placeholder">TO CONFIRM: jurisdiction</p><a href="mailto:hello@example.com">hello@example.com</a>',
  );
  const texts = found.map((entry) => entry.text).sort();
  assert.deepEqual(texts, ['TO CONFIRM', 'hello@example.com']);

  const duplicates = findPlaceholders('TO CONFIRM and TO CONFIRM');
  assert.equal(duplicates.filter((entry) => entry.text === 'TO CONFIRM').length, 1, 'each value is reported once');

  assert.deepEqual(
    findPlaceholders('<link rel="canonical" href="https://example.com/tools/x/">').map((entry) => entry.kind),
    ['example domain'],
  );
});

test('escapeHtml covers the characters that break an attribute', () => {
  assert.equal(escapeHtml(`<a href="x" & 'y'>`), '&lt;a href=&quot;x&quot; &amp; &#39;y&#39;&gt;');
});
