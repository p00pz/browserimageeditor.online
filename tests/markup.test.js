/**
 * Generated-markup tests for the collapse pattern.
 *
 * Every tool and target page folds its long prose away on a phone: the hero's intro and the four
 * editorial sections are each a `<details>` that carries only a `<summary>`, with the prose beside it in
 * a `.disclosure-body` that CSS reveals when the disclosure is open. That shape is generated (see
 * `secondarySection()` in `scripts/lib/tool-page.mjs`), and it is unusually easy to break in a way that
 * no other check notices:
 *
 *   - a body that keeps the wrong class, or loses it, simply never collapses — the page still renders,
 *     the audits still pass, and the only symptom is a drop zone pushed below the fold on a phone;
 *   - that is not hypothetical: the intro shipped with `<p class="tool-intro">` and no body class for one
 *     build, which made the page taller rather than shorter, and nothing but a live measurement caught it.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSite, localePath, siteRoutes } from '../scripts/lib/content.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every tool and target page on disk, for every locale that publishes it, as `{ label, html }`. */
function toolAndTargetPages() {
  const site = loadSite();
  const pages = [];
  for (const locale of site.locales) {
    const { routes } = siteRoutes(locale.code);
    for (const route of routes) {
      if (route.kind !== 'tool' && route.kind !== 'target') continue;
      const relative = localePath(site, locale.code, route.path);
      const file = resolve(root, 'src', relative.replace(/^\//, ''), 'index.html');
      pages.push({ label: `${locale.code}${route.path}`, html: readFileSync(file, 'utf8'), route });
    }
  }
  return pages;
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

test('every tool and target page wraps its intro so a phone can fold it away', () => {
  for (const { label, html } of toolAndTargetPages()) {
    /* Sliced to the block itself: asserting on the whole file dumps 500 lines when it fails. */
    const block = html.match(/<div class="intro-disclosure"[\s\S]{0,2000}?<\/p>/)?.[0] ?? '';
    const shape = /^<div class="intro-disclosure" data-collapsible>\s*<details><summary>[^<]+<\/summary><\/details>\s*<p class="tool-intro disclosure-body">/;
    assert.match(block, shape, `${label}: the hero's intro is not a disclosure with a disclosure body`);
  }
});

test('every disclosure on a tool page has a heading summary and a body beside it', () => {
  for (const { label, html } of toolAndTargetPages()) {
    const reveals = count(html, '<details><summary>');
    /* The class, not the whole attribute: the intro's body also carries `tool-intro`. */
    const bodies = count(html, 'disclosure-body');
    const markers = count(html, 'data-collapsible');

    assert.ok(reveals > 0, `${label}: no collapsible sections at all`);
    assert.equal(
      bodies,
      reveals,
      `${label}: ${reveals} disclosures but ${bodies} disclosure bodies — one of them cannot collapse`,
    );
    assert.equal(
      markers,
      reveals,
      `${label}: ${markers} data-collapsible wrappers but ${reveals} disclosures`,
    );
  }
});

test('no generated disclosure ships open, and each live page has exactly one primary action', () => {
  for (const { label, html, route } of toolAndTargetPages()) {
    assert.doesNotMatch(html, /<details[^>]*\sopen[\s>]/, `${label}: a disclosure is expanded in the markup`);
    assert.doesNotMatch(html, /data-collapsible[^>]*\sopen\b/, `${label}: a collapsible wrapper is marked open`);

    /* A parked page is asserted the other way round, in the test below. */
    if (route.status !== 'live') continue;

    const primaries = count(html, 'data-primary-action');
    assert.equal(primaries, 1, `${label}: ${primaries} elements claim to be the primary action`);
    assert.match(
      html,
      /data-primary-action data-sticky="off"/,
      `${label}: the primary action ships without its resting sticky state`,
    );
  }
});

test('a parked tool page promises no action, because there is none to take', () => {
  for (const { label, html, route } of toolAndTargetPages()) {
    if (route.status === 'live') continue;
    assert.equal(count(html, 'data-primary-action'), 0, `${label}: a parked page carries a primary action`);
    assert.equal(count(html, 'data-sticky'), 0, `${label}: a parked page carries a sticky bar`);
  }
});
