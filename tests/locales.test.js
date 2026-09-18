/**
 * hreflang / locale-scaffolding tests.
 *
 * Phase 5 added the URL layer that a second language would need, without adding a second language.
 * The point of testing it now is that the whole design claim is "adding /ar/ later does not move a
 * single existing URL" — and a claim like that is only worth making if something checks it.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alternateLinks,
  loadSite,
  loadTools,
  localeFor,
  localePath,
  localeSrcDir,
  pageFile,
  pageUrl,
  partialsPrefix,
  siteRoutes,
  srcDir,
  untranslatedFields,
} from '../scripts/lib/content.mjs';

/** A site with two languages, one of them right-to-left, without touching content/. */
const BILINGUAL = {
  name: 'ImageTools',
  tagline: 'Free image tools',
  url: 'https://example.com',
  description: 'Description.',
  ogImage: '/og/home.png',
  contactEmail: 'hello@example.com',
  contactRepo: null,
  defaultLocale: 'en',
  locales: [
    { code: 'en', label: 'English', dir: 'ltr' },
    { code: 'ar', label: 'Arabic', dir: 'rtl' },
  ],
  ads: false,
};

test('the default locale is prefixless, and a second one is prefixed', () => {
  assert.equal(localePath(BILINGUAL, 'en', '/tools/compress-image/'), '/tools/compress-image/');
  assert.equal(localePath(BILINGUAL, 'ar', '/tools/compress-image/'), '/ar/tools/compress-image/');
  assert.equal(localePath(BILINGUAL, 'en', '/'), '/');
  assert.equal(localePath(BILINGUAL, 'ar', '/'), '/ar/');
  assert.equal(localePath(BILINGUAL, 'ar', 'pages/about/'), '/ar/pages/about/', 'a missing leading slash is tolerated');

  assert.equal(pageUrl(BILINGUAL, 'en', '/'), 'https://example.com/');
  assert.equal(pageUrl(BILINGUAL, 'ar', '/'), 'https://example.com/ar/');
  assert.equal(pageUrl(BILINGUAL, 'ar', '/tools/compress-image/'), 'https://example.com/ar/tools/compress-image/');
});

test('alternates list the locales that actually publish the route, plus x-default', () => {
  const many = alternateLinks(BILINGUAL, '/tools/compress-image/');
  assert.deepEqual(many, [
    { hreflang: 'en', href: 'https://example.com/tools/compress-image/' },
    { hreflang: 'ar', href: 'https://example.com/ar/tools/compress-image/' },
    { hreflang: 'x-default', href: 'https://example.com/tools/compress-image/' },
  ]);

  // The homepage exists in both languages, and Phase 8 is what made that true for real content
  // rather than only for a fixture.
  assert.deepEqual(alternateLinks(loadSite(), '/'), [
    { hreflang: 'en', href: 'https://browserimageeditor.online/' },
    { hreflang: 'ar', href: 'https://browserimageeditor.online/ar/' },
    { hreflang: 'x-default', href: 'https://browserimageeditor.online/' },
  ]);

  // A route Arabic does not publish must not claim an Arabic twin: an alternate is a promise that
  // the page exists, and pointing a crawler at a URL that was never generated is worse than
  // declaring one language. Remove Background is the last English-only tool; crop-image, which this
  // test used to name, now has an Arabic page.
  const englishOnly = alternateLinks(loadSite(), '/tools/remove-background/');
  assert.deepEqual(englishOnly, [
    { hreflang: 'en', href: 'https://browserimageeditor.online/tools/remove-background/' },
    { hreflang: 'x-default', href: 'https://browserimageeditor.online/tools/remove-background/' },
  ]);
  assert.ok(
    !englishOnly.some((entry) => entry.hreflang === 'ar'),
    'English-only pages declare one language, and x-default still resolves to English',
  );

  // And the reciprocal direction, on a route that gained an Arabic page in this gate: the pair is
  // declared from both ends, which is what makes the hreflang set valid rather than one-sided.
  assert.deepEqual(alternateLinks(loadSite(), '/tools/crop-image/').map((entry) => entry.hreflang), [
    'en',
    'ar',
    'x-default',
  ]);
  assert.deepEqual(alternateLinks(loadSite(), '/pages/privacy/').map((entry) => entry.hreflang), [
    'en',
    'ar',
    'x-default',
  ]);
});

test('a non-default locale writes and reads from its own directory', () => {
  assert.equal(partialsPrefix(BILINGUAL, 'en'), '');
  assert.equal(partialsPrefix(BILINGUAL, 'ar'), 'ar/');
  assert.equal(localeSrcDir(BILINGUAL, 'en'), srcDir);
  assert.equal(localeSrcDir(BILINGUAL, 'ar'), `${srcDir}${process.platform === 'win32' ? '\\' : '/'}ar`);

  assert.equal(pageFile(BILINGUAL, 'en', '/tools/compress-image/'), `${srcDir}${sep()}tools${sep()}compress-image${sep()}index.html`);
  assert.equal(pageFile(BILINGUAL, 'ar', '/tools/compress-image/'), `${srcDir}${sep()}ar${sep()}tools${sep()}compress-image${sep()}index.html`);
  assert.equal(pageFile(BILINGUAL, 'en', '/'), `${srcDir}${sep()}index.html`);

  assert.deepEqual(localeFor(BILINGUAL, 'ar'), { code: 'ar', label: 'Arabic', dir: 'rtl' });
  assert.deepEqual(localeFor(BILINGUAL, 'zz'), BILINGUAL.locales[0], 'an unknown code falls back rather than throwing');
});

function sep() {
  return process.platform === 'win32' ? '\\' : '/';
}

test('a locale with no translation file falls back to the default copy, out loud', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(message);
  let site;
  try {
    site = loadSite('zz');
  } finally {
    console.warn = original;
  }

  assert.equal(site.defaultLocale, 'en');
  assert.equal(site.name, loadSite().name, 'the fallback copy is the default locale’s, not empty');
  assert.ok(
    warnings.some((message) => /content\/zz\/site\.json does not exist/.test(message)),
    'a silent fallback is how a half-translated site ships without anyone noticing',
  );
});

test('a translation file is a publish list, not a merge', () => {
  // Arabic translates six of the seven tools and the homepage, and now every standalone page. Their
  // metadata is Arabic; the tool it does not translate does not exist under /ar/ at all. The
  // alternative — publishing the English entry under an Arabic URL — produces a page whose title is
  // identical to its English twin, which the SEO audit rejects, so the two mechanisms have to agree
  // about this.
  const english = loadTools();
  const arabic = loadTools('ar');

  assert.deepEqual(
    arabic.map((tool) => tool.id),
    ['compress', 'resize', 'convert', 'crop', 'image-to-pdf', 'enhance-photo'],
    'Arabic publishes exactly the tools its overlay lists',
  );
  assert.ok(
    english.length > arabic.length,
    'and the default locale still publishes everything, because no overlay exists for it',
  );

  const compress = arabic.find((tool) => tool.id === 'compress');
  assert.notEqual(compress.title, english.find((tool) => tool.id === 'compress').title);
  assert.equal(compress.slug, 'compress-image', 'slug is a URL and is never translated');
  assert.equal(compress.status, 'live', 'status is configuration, not copy');
  assert.equal(compress.faq.length, english.find((tool) => tool.id === 'compress').faq.length);

  // Nothing published in Arabic may be part English: a field left untranslated is a build failure,
  // not a fallback, because that is what a half-translated page looks like from the inside — and it
  // is also what would give the two pages the same <title>.
  const englishEntry = english.find((tool) => tool.id === 'compress');
  const translation = {
    name: 'ضغط الصور',
    title: 'ضغط الصور عبر الإنترنت',
    description: 'وصف',
    h1: 'عنوان',
    intro: 'مقدمة',
    navLabel: 'الضغط',
    keywords: ['ضغط'],
    targetKeyword: 'ضغط',
    faq: englishEntry.faq,
  };
  const fields = Object.keys(translation);
  assert.deepEqual(untranslatedFields(translation, englishEntry, fields), [], 'a complete translation passes');
  assert.deepEqual(
    untranslatedFields({ ...translation, intro: undefined }, englishEntry, fields),
    ['intro'],
    'one missing field is named, not tolerated',
  );
  assert.deepEqual(
    untranslatedFields({ ...translation, title: '   ' }, englishEntry, fields),
    ['title'],
    'whitespace is not a translation',
  );
  // A field the default entry does not use is not demanded: requiring a FAQ translation for a tool
  // that has no FAQ would fail a page that is in fact fully translated.
  assert.deepEqual(untranslatedFields(translation, { ...englishEntry, faq: [] }, fields), []);
});

test('an untranslated entry is not published, and it says so', () => {
  // The warning is the difference between "Arabic has three tools" being a decision and being an
  // accident: the loader names every entry that stayed default-locale-only.
  const lines = [];
  const original = console.log;
  console.log = (message) => lines.push(String(message));
  try {
    loadTools('ar');
  } finally {
    console.log = original;
  }
  assert.ok(
    lines.some((line) => /"ar" publishes 6 of 7 tools\.json entries/.test(line)),
    'the loader reports the subset it published',
  );
  assert.ok(
    lines.some((line) => /staying default-locale-only: remove-background/.test(line)),
    'and names the entries that are English-only, so the gap is listed rather than guessed at',
  );
});

test('the route inventory is one list, and it is what the generators write', () => {
  const { site, code, routes } = siteRoutes();
  assert.equal(site.defaultLocale, code, 'no code means the default locale');
  assert.equal(routes[0].kind, 'home');
  assert.equal(routes[0].path, '/');

  const kinds = routes.reduce((counts, route) => {
    counts[route.kind] = (counts[route.kind] ?? 0) + 1;
    return counts;
  }, {});
  // Six standalone pages: about, how-it-works, privacy, terms, contact and the offline fallback the
  // service worker serves. It is a route like any other — it is just not advertised anywhere. Seven
  // tools, counting Remove Background, which is published as a coming-soon page while its engine is
  // still being written.
  assert.deepEqual(kinds, { home: 1, tool: 7, target: 14, page: 6 });
  assert.ok(routes.every((route) => route.path.startsWith('/') && route.path.endsWith('/')));

  // Every route resolves to a URL in the locale it belongs to, and no two routes collide.
  const urls = routes.map((route) => pageUrl(site, code, route.path));
  assert.equal(new Set(urls).size, urls.length);

  // A locale publishes a subset, so its inventory is spelled out by kind rather than pinned as a
  // 27-line literal that grows with every translation. The boundary that matters is *what is
  // missing*: the untranslated tool, and nothing else.
  const arabic = siteRoutes('ar');
  const englishPaths = new Set(routes.map((route) => route.path));
  const arabicKinds = arabic.routes.reduce((counts, route) => {
    counts[route.kind] = (counts[route.kind] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(arabicKinds, { home: 1, tool: 6, target: 14, page: 6 },
    'Arabic is the homepage, the six translated tools, all fourteen guides and the six standalone pages');
  assert.deepEqual(
    arabic.routes.filter((route) => !englishPaths.has(route.path)).map((route) => route.path),
    [],
    'every Arabic route mirrors an English one',
  );
  assert.deepEqual(
    routes
      .filter((route) => !arabic.routes.some((translated) => translated.path === route.path))
      .map((route) => route.path),
    ['/tools/remove-background/'],
    'Remove Background is the one route left English-only, by decision, not by oversight',
  );
  assert.ok(
    arabic.routes.every((route) => englishPaths.has(route.path)),
    'a translated route mirrors an English one; it never introduces a new path',
  );
  assert.ok(
    arabic.routes.length < routes.length,
    'the subset is smaller than the English inventory, which is the whole point of a publish list',
  );
  assert.ok(
    !arabic.routes.some((route) => route.path === '/tools/remove-background/'),
    'the one tool with no Arabic overlay stays English-only, as a publish list means',
  );
});

test('two locales are configured, and every one of their routes carries the right prefix', () => {
  const site = loadSite();
  assert.equal(site.locales.length, 2);
  assert.equal(site.locales[0].code, site.defaultLocale);
  assert.equal(site.locales[0].dir, 'ltr');

  for (const route of siteRoutes().routes) {
    const url = pageUrl(site, site.defaultLocale, route.path);
    assert.ok(!url.startsWith(`${site.url}/en/`), `${url} must not be prefixed while English is the default`);
  }

  // The Arabic routes are the same paths under a prefix, which is what keeps one inventory list
  // honest across languages.
  for (const route of siteRoutes('ar').routes) {
    const url = pageUrl(site, 'ar', route.path);
    assert.ok(
      url.startsWith(`${site.url}/ar/`) || url === `${site.url}/ar/`,
      `${url} must live under /ar/`,
    );
  }
});
