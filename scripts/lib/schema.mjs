/**
 * Schema.org JSON-LD builders — pure functions over the content model.
 *
 * Everything here is data in, data out: no filesystem, no HTML. That is what lets
 * tests/seo.test.js check the required properties of each type, and scripts/audit-seo.mjs check
 * the same shapes on the pages that were actually written, without a second implementation.
 *
 * Two decisions worth knowing:
 *
 *   - One `@graph` per page with a single `@context`, rather than several <script> blocks. Nodes
 *     carry stable fragment `@id`s (`…#software`, `…#faq`, `…#breadcrumb`) so they can be
 *     referenced later without renaming anything.
 *   - `FAQPage` is emitted even though Google retired the FAQ rich result in May 2026 (the docs
 *     were removed in June). It stays valid schema.org and is still read by other consumers, so it
 *     costs nothing to keep even though it earns no rich result.
 */
import { label } from './tool-page.mjs';

/**
 * Required properties per type, per the types' own vocabularies and Google's documented feature
 * requirements. Used by the validator below, which both the tests and the audit script call.
 */
const REQUIRED = {
  WebSite: ['name', 'url'],
  Organization: ['name', 'url'],
  SoftwareApplication: ['name', 'applicationCategory', 'operatingSystem', 'offers'],
  FAQPage: ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
  Question: ['name', 'acceptedAnswer'],
  Answer: ['text'],
  ListItem: ['position', 'name', 'item'],
  Offer: ['price', 'priceCurrency'],
};

/** Types whose presence on a page is meaningful, so the audit can assert the expected shape. */
export const URL_PROPERTIES = ['url', 'item', 'image', 'logo'];

function absolute(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}

/**
 * The site node, anchored to the locale's own homepage.
 *
 * `homeUrl` is passed in rather than derived, because on an Arabic page the homepage is `/ar/` and
 * the site's name and description are the translated ones. Emitting the English `@id` here would
 * describe a different page under this URL — the audit checks that something in the graph is
 * anchored to the page it is on, and it is right to.
 */
export function webSite({ site, locale, lang, homeUrl = null, description = null }) {
  const home = homeUrl ?? `${site.url}/`;
  return {
    '@type': 'WebSite',
    '@id': `${home}#website`,
    url: home,
    name: site.name,
    description: description ?? site.description,
    inLanguage: lang,
    publisher: { '@id': `${site.url}/#organization` },
  };
}

export function organization({ site, logoUrl, homeUrl = null }) {
  return {
    '@type': 'Organization',
    '@id': `${site.url}/#organization`,
    name: site.name,
    url: homeUrl ?? `${site.url}/`,
    logo: logoUrl,
    // The two contact points we can actually stand behind. No address, no phone, no founding date:
    // a knowledge-panel claim has to be true, and inventing a postal address would not be.
    email: site.contactEmail,
    ...(site.contactRepo ? { sameAs: [site.contactRepo] } : {}),
  };
}

/**
 * The tool itself. It is genuinely free, so a zero-price offer is accurate — and there is
 * deliberately no `aggregateRating`, because we have no ratings and inventing them would be both
 * dishonest and a guidelines violation. Google's Software App markup is aimed at rated apps, so
 * the Rich Results Test may note this page is not eligible for that one feature; that is a note,
 * not an error.
 */
export function softwareApplication({ tool, url, imageUrl, lang }) {
  return {
    '@type': 'SoftwareApplication',
    '@id': `${url}#software`,
    name: tool.name,
    description: tool.description,
    url,
    image: imageUrl,
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Any (web browser)',
    browserRequirements: 'Requires a browser with Canvas and Web Worker support.',
    isAccessibleForFree: true,
    inLanguage: lang,
    offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' },
    // Facts, not marketing: the formats this tool really takes and really writes.
    featureList: [
      `Accepts ${tool.accepts.map(label).join(', ')}`,
      'Processes images entirely inside the browser, with no upload',
    ],
  };
}

export function faqPage({ url, faq }) {
  return {
    '@type': 'FAQPage',
    '@id': `${url}#faq`,
    mainEntity: faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

/** `items` are `{ name, url }` in order, starting at the home page. */
export function breadcrumbList({ url, items }) {
  return {
    '@type': 'BreadcrumbList',
    '@id': `${url}#breadcrumb`,
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/** Wraps nodes in one graph with one context, dropping anything absent. */
export function jsonLdScript(nodes) {
  const graph = { '@context': 'https://schema.org', '@graph': nodes.filter(Boolean) };
  const json = JSON.stringify(graph, null, 2).replace(/</g, '\\u003c');
  return `  <script type="application/ld+json">\n${json}\n  </script>`;
}

function walk(node, path, problems) {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => walk(entry, `${path}[${index}]`, problems));
    return;
  }
  if (node === null || typeof node !== 'object') return;

  const type = node['@type'];
  if (typeof type === 'string') {
    const required = REQUIRED[type];
    if (!required) {
      problems.push(`${path}: unknown @type "${type}" — add it to REQUIRED if it is intended`);
    } else {
      for (const property of required) {
        const value = node[property];
        const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
        if (empty) problems.push(`${path} (${type}): missing required property "${property}"`);
      }
    }
  }

  for (const [property, value] of Object.entries(node)) {
    if (URL_PROPERTIES.includes(property) && typeof value === 'string' && !absolute(value)) {
      problems.push(`${path}.${property}: must be an absolute URL, received "${value}"`);
    }
    walk(value, `${path}.${property}`, problems);
  }
}

/**
 * Structural validation of a graph. Returns a list of problems, empty when the graph is sound.
 * Deliberately stricter than schema.org itself: a missing required property is how a rich result
 * silently never appears.
 */
export function validateGraph(graph, { pageUrl = null } = {}) {
  const problems = [];
  if (graph === null || typeof graph !== 'object') return ['graph is not an object'];
  if (graph['@context'] !== 'https://schema.org') {
    problems.push(`@context must be "https://schema.org", received ${JSON.stringify(graph['@context'])}`);
  }
  if (!Array.isArray(graph['@graph']) || graph['@graph'].length === 0) {
    return [...problems, '@graph must be a non-empty array'];
  }

  graph['@graph'].forEach((node, index) => walk(node, `@graph[${index}]`, problems));

  // Breadcrumb positions have to be a 1-based run, or Google reads the trail out of order.
  for (const node of graph['@graph']) {
    if (node['@type'] !== 'BreadcrumbList') continue;
    const positions = (node.itemListElement ?? []).map((item) => item.position);
    const expected = positions.map((_, index) => index + 1);
    if (positions.join(',') !== expected.join(',')) {
      problems.push(`@graph BreadcrumbList: positions must run 1..n in order, received [${positions.join(', ')}]`);
    }
  }

  if (pageUrl) {
    const ids = new Set();
    for (const node of graph['@graph']) {
      if (typeof node['@id'] === 'string' && ids.has(node['@id'])) {
        problems.push(`@graph: duplicate @id "${node['@id']}"`);
      }
      if (typeof node['@id'] === 'string') ids.add(node['@id']);
    }
    const owners = graph['@graph'].filter((node) => typeof node['@id'] === 'string' && node['@id'].startsWith(pageUrl));
    if (owners.length === 0) {
      problems.push(`no node is anchored to this page (${pageUrl}) — every page-level node should carry an @id under its own URL`);
    }
  }

  return problems;
}
