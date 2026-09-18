/**
 * Technical-SEO tests. Two things are checked here that nothing else can check:
 *
 *   1. the JSON-LD builders produce graphs that validate, including the failure modes that kill a
 *      rich result silently (a missing required property, a relative URL, breadcrumbs out of order);
 *   2. the generated artefacts on disk agree with the content model — one social card per live
 *      route, sitemap parity, robots pointing at the real origin, and the audit script itself
 *      exiting clean. That last one is what stops scripts/audit-seo.mjs from rotting: if a page
 *      drops its canonical, this suite fails with the audit's own message.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPages, loadSite, loadTargets, loadTools, pageUrl, publicDir, siteRoutes } from '../scripts/lib/content.mjs';
import { OG_HEIGHT, OG_WIDTH, PALETTE, ogCardTree, ogCards, ogTreeToHtml } from '../scripts/lib/og-card.mjs';
import {
  breadcrumbList,
  faqPage,
  jsonLdScript,
  organization,
  softwareApplication,
  validateGraph,
  webSite,
} from '../scripts/lib/schema.mjs';
import { OG_SIZE, ogImageKey, ogImagePath, ogImageUrl } from '../scripts/lib/tool-page.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every generated page, one per route per locale, from the same inventory the build uses. */
function allRoutes() {
  const site = loadSite();
  const routes = [];
  for (const locale of site.locales) {
    const { site: localeSite, routes: localeRoutes } = siteRoutes(locale.code);
    for (const route of localeRoutes) {
      routes.push({ ...route, locale: locale.code, site: localeSite, url: pageUrl(localeSite, locale.code, route.path) });
    }
  }
  return routes;
}

test('every JSON-LD graph the build emits is structurally valid', () => {
  const site = loadSite();
  const tools = loadTools();
  const targets = loadTargets(tools);
  const pages = loadPages();

  const graphs = [
    ['home', jsonLdScript([webSite({ site, locale: 'en', lang: 'en' }), organization({ site, logoUrl: ogImageUrl(site, 'en', 'home') })])],
  ];

  for (const tool of tools.filter((entry) => entry.status === 'live')) {
    const url = `${site.url}${'/tools/'}${tool.slug}/`;
    graphs.push([
      `tool ${tool.id}`,
      jsonLdScript([
        softwareApplication({ tool, url, lang: 'en', imageUrl: ogImageUrl(site, 'en', ogImageKey('tool', tool.slug)) }),
        tool.faq.length > 0 ? faqPage({ url, faq: tool.faq }) : null,
        breadcrumbList({
          url,
          items: [
            { name: 'All tools', url: `${site.url}/` },
            { name: tool.name, url },
          ],
        }),
      ]),
    ]);
  }

  for (const target of targets) {
    const url = `${site.url}/targets/${target.slug}/`;
    graphs.push([
      `target ${target.slug}`,
      jsonLdScript([
        faqPage({ url, faq: target.faq }),
        breadcrumbList({
          url,
          items: [
            { name: 'All tools', url: `${site.url}/` },
            { name: 'parent', url: `${site.url}/tools/x/` },
            { name: target.navLabel, url },
          ],
        }),
      ]),
    ]);
  }

  assert.equal(graphs.length, 1 + tools.filter((entry) => entry.status === 'live').length + targets.length);
  assert.ok(pages.length > 0);

  for (const [label, script] of graphs) {
    const json = JSON.parse(script.match(/<script type="application\/ld\+json">\n([\s\S]*)\n {2}<\/script>/)[1]);
    assert.deepEqual(validateGraph(json, { pageUrl: json['@graph'][0]['@id'].split('#')[0] }), [], `${label} should validate`);
  }
});

test('the graph validator refuses each way a rich result dies silently', () => {
  const site = { url: 'https://example.com', name: 'Site', description: 'd', contactEmail: 'a@b.c', contactRepo: null };
  const url = `${site.url}/tools/x/`;
  const good = jsonLdScript([
    softwareApplication({
      tool: { name: 'T', description: 'd', accepts: ['image/jpeg'] },
      url,
      lang: 'en',
      imageUrl: `${site.url}/og/tool-x.png`,
    }),
    faqPage({ url, faq: [{ q: 'Q?', a: 'A.' }] }),
    breadcrumbList({ url, items: [{ name: 'All tools', url: `${site.url}/` }, { name: 'T', url }] }),
  ]);
  const parse = (script) => JSON.parse(script.match(/<script type="application\/ld\+json">\n([\s\S]*)\n {2}<\/script>/)[1]);

  assert.deepEqual(validateGraph(parse(good), { pageUrl: url }), []);

  const cases = [
    [
      'a required property is missing',
      { '@context': 'https://schema.org', '@graph': [{ '@type': 'SoftwareApplication', name: 'T' }] },
      /missing required property "applicationCategory"/,
    ],
    [
      'the context is wrong',
      { '@context': 'http://schema.org', '@graph': [{ '@type': 'WebSite', name: 'n', url: `${site.url}/` }] },
      /@context must be/,
    ],
    [
      'a URL property is relative',
      { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite', name: 'n', url: '/relative' }] },
      /must be an absolute URL/,
    ],
    [
      'an unknown type is used',
      { '@context': 'https://schema.org', '@graph': [{ '@type': 'Thing', name: 'n' }] },
      /unknown @type "Thing"/,
    ],
    [
      'the graph is empty',
      { '@context': 'https://schema.org', '@graph': [] },
      /@graph must be a non-empty array/,
    ],
  ];
  for (const [label, graph, expected] of cases) {
    assert.ok(
      validateGraph(graph, {}).some((problem) => expected.test(problem)),
      `${label}: expected a problem matching ${expected}`,
    );
  }

  const outOfOrder = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 2, name: 'b', item: `${site.url}/b/` },
          { '@type': 'ListItem', position: 1, name: 'a', item: `${site.url}/a/` },
        ],
      },
    ],
  };
  assert.ok(validateGraph(outOfOrder, {}).some((problem) => /positions must run 1\.\.n/.test(problem)));

  const twoNodesOneId = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${site.url}/#website`, name: 'n', url: `${site.url}/` },
      { '@type': 'Organization', '@id': `${site.url}/#website`, name: 'n', url: `${site.url}/` },
    ],
  };
  // Both of these need the page URL, which is why the audit and the builders always pass it.
  assert.ok(
    validateGraph(twoNodesOneId, { pageUrl: `${site.url}/` }).some((problem) => /duplicate @id/.test(problem)),
  );

  // A graph whose nodes are all anchored somewhere else gives the page nothing of its own.
  assert.ok(
    validateGraph(twoNodesOneId, { pageUrl: `${site.url}/tools/x/` }).some((problem) =>
      /no node is anchored to this page/.test(problem),
    ),
  );
});

test('there is exactly one social card per generated page, in every locale', () => {
  const site = loadSite();
  let cardsSeen = 0;

  // Per locale, because a page's head names its own `og:image` and a non-default locale's cards live
  // under `/<locale>/og/`. The keys are the same in both languages — `tool-compress-image` — and the
  // directory is what separates them, which is why the card list is built from the locale's own
  // content rather than from one global list.
  for (const locale of site.locales) {
    const tools = loadTools(locale.code);
    const cards = ogCards({
      site: loadSite(locale.code),
      locale: locale.code,
      tools,
      targets: loadTargets(tools, locale.code),
      pages: loadPages(locale.code),
    });
    cardsSeen += cards.length;

    // One card per page the generators emit, not per live route: a page's head says `og:image`, so a
    // missing card is a 404 on a real URL. The offline fallback is the reason this is not simply
    // "live routes" — it is generated, so it needs a card, while a planned guide is not generated
    // at all and needs none.
    const { routes } = siteRoutes(locale.code);
    const generated = routes.filter((route) => route.kind !== 'target' || route.status === 'live');
    assert.equal(
      cards.length,
      generated.length,
      `"${locale.code}": a card per generated page, no more and no fewer`,
    );

    const keys = cards.map((card) => card.key);
    assert.equal(
      new Set(keys).size,
      keys.length,
      `"${locale.code}": card keys must be unique, or one page overwrites another`,
    );

    for (const route of generated) {
      const expected =
        route.kind === 'home'
          ? ogImageKey('home')
          : route.kind === 'tool'
            ? ogImageKey('tool', route.entry.slug)
            : route.kind === 'target'
              ? ogImageKey('guide', route.entry.slug)
              : ogImageKey('page', route.entry.slug);
      assert.ok(keys.includes(expected), `no card for ${locale.code}/${route.path} (expected "${expected}")`);
    }

    for (const card of cards) {
      assert.ok(card.title.trim().length > 0, `card ${card.key} has no title`);
      assert.ok(card.description.trim().length > 0, `card ${card.key} has no description`);
      assert.ok(!/undefined|\bnull\b|NaN/.test(`${card.title}${card.description}`), `card ${card.key} leaked a placeholder`);
    }
  }

  assert.ok(cardsSeen > site.locales.length, 'the card list is more than a per-locale stub');
});

test('the preview sheet and the rasteriser are handed the same tree', () => {
  const site = loadSite();
  const card = { key: 'tool-x', kind: 'tool', eyebrow: 'Tool', title: 'A & B <script>', description: 'D' };

  const html = ogTreeToHtml(card, { site });
  assert.ok(html.includes('A &amp; B &lt;script&gt;'), 'card text is escaped, never injected as markup');
  assert.ok(!html.includes('<script>'), 'an angle bracket in content must not become an element');

  const tree = ogCardTree(card, { site });
  assert.equal(tree.props.style.width, `${OG_WIDTH}px`);
  assert.equal(tree.props.style.height, `${OG_HEIGHT}px`);
  assert.equal(OG_WIDTH, OG_SIZE.width, 'the card model and the og:image:width meta tag must agree');
  assert.equal(OG_HEIGHT, OG_SIZE.height);

  // Long titles step down a size instead of wrapping into a fourth line.
  const sizes = ['short', 'x'.repeat(60), 'x'.repeat(120)].map(
    (title) => ogCardTree({ ...card, title }, { site }).props.children[1].props.children[0].props.style.fontSize,
  );
  assert.deepEqual(sizes, ['72px', '58px', '48px']);
});

test('the card palette still matches the dark-mode tokens it is copied from', () => {
  const css = readFileSync(resolve(root, 'src/assets/css/base.css'), 'utf8');
  const dark = css.slice(css.indexOf('prefers-color-scheme: dark'));
  const token = (name) => dark.match(new RegExp(`--color-${name}:\\s*([^;]+);`))?.[1].trim();

  assert.equal(PALETTE.background, token('bg'));
  assert.equal(PALETTE.surface, token('surface'));
  assert.equal(PALETTE.border, token('border'));
  assert.equal(PALETTE.text, token('text'));
  assert.equal(PALETTE.muted, token('text-muted'));
  assert.equal(PALETTE.accent, token('primary'));
});

test('a share image exists for every route, at the size the page announces', () => {
  const site = loadSite();
  for (const route of allRoutes()) {
    const key =
      route.kind === 'home'
        ? ogImageKey('home')
        : route.kind === 'tool'
          ? ogImageKey('tool', route.entry.slug)
          : route.kind === 'target'
            ? ogImageKey('guide', route.entry.slug)
            : ogImageKey('page', route.entry.slug);

    const relative = ogImagePath(route.site, route.locale, key);
    const file = resolve(publicDir, relative.replace(/^\//, ''));
    assert.ok(existsSync(file), `${relative} is missing — run npm run gen:og`);

    const bytes = readFileSync(file);
    assert.equal(bytes.toString('ascii', 1, 4), 'PNG', `${relative} is not a PNG`);
    assert.equal(bytes.readUInt32BE(16), OG_SIZE.width);
    assert.equal(bytes.readUInt32BE(20), OG_SIZE.height);
    assert.ok(bytes.length > 5000, `${relative} is suspiciously small — probably an empty canvas`);
  }
});

test('a non-default locale files its cards under its own directory', () => {
  const site = { ...loadSite(), defaultLocale: 'en' };
  assert.equal(ogImagePath(site, 'en', 'home'), '/og/home.png');
  assert.equal(ogImagePath(site, 'ar', 'home'), '/ar/og/home.png');
  assert.equal(ogImageUrl(site, 'ar', 'home'), `${site.url}/ar/og/home.png`);
});

test('the sitemap and robots.txt agree with the route inventory', () => {
  const site = loadSite();
  const sitemap = readFileSync(resolve(publicDir, 'sitemap.xml'), 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);
  const live = allRoutes().filter((route) => route.status === 'live').map((route) => route.url);

  assert.equal(locs.length, live.length, 'one <loc> per live route');
  assert.deepEqual([...locs].sort(), [...live].sort());

  const robots = readFileSync(resolve(publicDir, 'robots.txt'), 'utf8');
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.ok(robots.includes(`Sitemap: ${site.url}/sitemap.xml`), 'robots.txt must point at the real origin');
});

test('the SEO audit itself exits clean on the tree as it stands', () => {
  const output = execFileSync(process.execPath, ['scripts/audit-seo.mjs'], { cwd: root, encoding: 'utf8' });

  assert.match(output, /audit-seo: \d+ pages/);
  assert.match(output, /audit-seo: 0 errors/, `the audit found errors:\n${output}`);
  assert.ok(!/ERR /.test(output), `the audit reported at least one error:\n${output}`);
});

test('the audit fails loudly when a page is broken', () => {
  // The audit must not be a script that always passes. Renaming a page's file out of the way is the
  // cheapest way to prove it reports and exits non-zero — and it is put back immediately.
  const target = resolve(root, 'src/tools/compress-image/index.html');
  const moved = `${target}.audit-probe`;
  renameSync(target, moved);
  try {
    let failed = false;
    try {
      execFileSync(process.execPath, ['scripts/audit-seo.mjs'], { cwd: root, encoding: 'utf8' });
    } catch (error) {
      failed = true;
      assert.match(String(error.stdout), /is missing — .*has no file on disk/);
      assert.notEqual(error.status, 0);
    }
    assert.ok(failed, 'the audit passed with a page missing from disk');
  } finally {
    renameSync(moved, target);
  }
  assert.ok(existsSync(target), 'the probe must restore the file it moved');
});
