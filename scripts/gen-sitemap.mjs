#!/usr/bin/env node
/**
 * Generates public/sitemap.xml and public/robots.txt.
 *
 * Routes are derived from content/tools.json and content/targets.json rather than from
 * whatever happens to be on disk, so the sitemap can never drift from the content model.
 * robots.txt is generated too, because a Sitemap: line must be an absolute URL and the
 * canonical origin lives in content/site.json.
 *
 * Deliberately no <lastmod>: a build-time timestamp would make every run a diff and
 * would tell crawlers nothing useful.
 *
 * Output:
 *   public/sitemap.xml
 *   public/robots.txt
 */
import { resolve } from 'node:path';
import { alternateLinks, loadSite, pageUrl, publicDir, siteRoutes } from './lib/content.mjs';
import { generatedBanner, reportWrites, writeGenerated } from './lib/render.mjs';

const BY = 'scripts/gen-sitemap.mjs';
const FROM = 'content/tools.json + content/targets.json + content/pages.json';

const site = loadSite();
const banner = generatedBanner({ by: BY, from: FROM });

/**
 * One entry per route per locale. With one locale that is 25 URLs; with two it is 50, each carrying
 * the alternates that point at its counterpart — which is what keeps hreflang reciprocal without
 * anyone maintaining two lists by hand.
 *
 * The route list itself comes from content.mjs so that this file and scripts/audit-seo.mjs cannot
 * disagree about which pages exist. A planned page is generated and checked but not advertised,
 * which is why the filter is here rather than inside the route builder.
 */
const routes = [];
for (const locale of site.locales) {
  const code = locale.code;
  const { site: localeSite, routes: localeRoutes } = siteRoutes(code);
  for (const route of localeRoutes) {
    if (route.status !== 'live') continue;
    routes.push({
      loc: pageUrl(localeSite, code, route.path),
      priority: route.priority,
      alternates: alternateLinks(localeSite, route.path),
    });
  }
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '"') return '&quot;';
    return '&apos;';
  });
}

const urlEntries = routes
  .map((route) => {
    const alternates = route.alternates
      .map(
        ({ hreflang, href }) =>
          `    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${escapeXml(href)}"/>`,
      )
      .join('\n');
    return `  <url>\n    <loc>${escapeXml(route.loc)}</loc>\n${alternates}\n    <priority>${route.priority}</priority>\n  </url>`;
  })
  .join('\n');

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n${banner}\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urlEntries}\n</urlset>\n`;

const robotsBanner = banner.replace('<!--', '#').replace('-->', '').trimEnd();
const robots = `${robotsBanner}\nUser-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n`;

const results = [
  writeGenerated(resolve(publicDir, 'sitemap.xml'), sitemap),
  writeGenerated(resolve(publicDir, 'robots.txt'), robots),
];

reportWrites(results, { prefix: `gen-sitemap (${routes.length} routes)` });
