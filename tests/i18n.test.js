/**
 * Localisation tests.
 *
 * The locale *model* — prefixes, publish lists, reciprocal alternates — is covered by
 * tests/locales.test.js. This file covers the other half: the string catalogue itself, which is the
 * part a build audit cannot see.
 *
 * The important ones are the wiring tests. `scripts/audit-seo.mjs` reads generated HTML, so it can
 * tell you a page links `rtl.css`; it cannot tell you that a tool script asks for a string nobody
 * ever wrote, because that failure happens *after* the page has loaded cleanly. The button that
 * relabels itself from `js.compress.runAgain` was exactly that: valid HTML, valid JavaScript, and a
 * visible raw key on screen the moment the first batch finished. Test 2 is what catches that class.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import test from 'node:test';

import {
  alternateLinks,
  loadSite,
  loadTools,
  loadUi,
  localePath,
  markupStrings,
  projectRoot,
  runtimeStrings,
  srcDir,
} from '../scripts/lib/content.mjs';
import { RESIZE_PRESETS } from '../src/assets/js/core/presets.js';
import { MIME_LABELS, acceptHint, chromeStrings } from '../scripts/lib/tool-page.mjs';
import { createStrings, interpolate } from '../src/assets/js/ui/strings.js';

/** Every file under `dir` whose extension is in `extensions`, as absolute paths. */
function filesUnder(dir, extensions) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path, extensions));
    else if (extensions.includes(extname(entry.name))) found.push(path);
  }
  return found;
}

const EN_CATALOG = loadUi();
const AR_CATALOG = loadUi('ar');

/**
 * Latin words that are *supposed* to appear in Arabic copy.
 *
 * Product names (Chrome, Edge), the product's own name, the library named in a user-visible
 * sentence, and two `<code>` snippets naming real APIs. Anything else Latin in an Arabic string is an
 * untranslated leftover, which is what the Arabic-ness test fails on. Keeping this list short and
 * explicit is the point: a new entry is a deliberate decision somebody has to make.
 *
 * Format names are folded in from `MIME_LABELS` rather than listed by hand, so adding AVIF or GIF to
 * the site cannot fail the translation tests for the wrong reason.
 */
const LATIN_ALLOWLIST = new Set([
  ...Object.values(MIME_LABELS),
  'canvas',
  'canvas.toBlob',
  'Chrome',
  'Edge',
  'English',
  'Firefox',
  // An operating-system name, same class as the browsers above: «iOS» stays Latin in Arabic too.
  'iOS',
  'HEIC',
  'HEIF',
  'ImageTools',
  // A page size rather than a phrase: "US Letter" is how the format is named everywhere, and
  // «مقاس US Letter» is how an Arabic page refers to it.
  'Letter',
  'Lanczos',
  'OffscreenCanvas',
  'Safari',
  'Web',
  'Worker',
  'ZIP',
]);

test('the catalogue splits cleanly into the markup half and the runtime half', () => {
  const runtime = runtimeStrings(EN_CATALOG);
  const markup = markupStrings(EN_CATALOG);

  /*
   * The two halves are keyed differently, and both differences are load-bearing.
   *
   * The runtime block keeps the catalogue's own `js.` names, because that is what a script writes:
   * `t('js.common.waiting')`. Stripping the prefix on the way in meant no lookup could ever succeed,
   * so this loop is the shape of the bug it exists to prevent.
   *
   * The markup half is re-keyed to `t.ui.…` because a template token must not collide with anything
   * else in the render data.
   */
  for (const name of Object.keys(runtime)) assert.ok(name.startsWith('js.'), name);
  for (const name of Object.keys(markup)) assert.ok(name.startsWith('t.ui.'), name);

  // A runtime key is exactly a catalogue key: no transformation, nothing to get wrong.
  for (const name of Object.keys(runtime)) {
    assert.equal(runtime[name], EN_CATALOG[name], name);
  }

  const runtimeCount = Object.keys(EN_CATALOG).filter((name) => name.startsWith('js.')).length;
  const markupCount = Object.keys(EN_CATALOG).filter((name) => name.startsWith('ui.')).length;
  assert.equal(Object.keys(runtime).length, runtimeCount);
  assert.equal(Object.keys(markup).length, markupCount);
  assert.ok(runtimeCount > 0 && markupCount > 0, 'both halves are in use');

  // The two halves together are the whole catalogue, with nothing counted twice. The prefixes make
  // this true by construction, so the check is here to keep it true if the prefixes are ever changed.
  assert.equal(runtimeCount + markupCount, Object.keys(EN_CATALOG).length);

  /*
   * `js.x` and `ui.x` may legitimately coexist — `ui.compress.unsupported` is the long explanation
   * with the `<code>OffscreenCanvas</code>` in it, while `js.compress.unsupported` is the one-line
   * runtime notice. But two keys carrying the *same text* are a duplicate that should have been a
   * single key, whichever half it lives in.
   */
  const identical = Object.keys(runtime)
    .filter((name) => EN_CATALOG[`ui.${name}`] !== undefined)
    .filter((name) => EN_CATALOG[`ui.${name}`] === EN_CATALOG[`js.${name}`]);
  assert.deepEqual(identical, [], 'these keys duplicate each other across the markup and runtime halves');
});

test('every string key the code asks for exists in the catalogue', () => {
  /*
   * Literal references, in both halves of the source: a script calls `t('js.…')`, and a template
   * writes `{{t.ui.…}}`. A key that exists in neither place is caught by the partition test above,
   * so this test's job is the other direction — a reference with no string behind it.
   */
  const referenced = new Map();
  const pattern = /['"`]((?:js|ui)\.[A-Za-z0-9_.-]+)['"`]|t\.((?:ui)\.[A-Za-z0-9_.-]+)/g;

  for (const file of filesUnder(join(srcDir, 'assets', 'js'), ['.js'])) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      const key = match[1] ?? match[2];
      if (!referenced.has(key)) referenced.set(key, file);
    }
  }
  const templates = filesUnder(join(srcDir, 'templates'), ['.html']);
  for (const file of templates) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\{\{\{?(t\.ui\.[A-Za-z0-9_.-]+)\}?\}\}/g)) {
      const key = match[1].slice('t.'.length);
      if (!referenced.has(key)) referenced.set(key, file);
    }
  }

  assert.ok(referenced.size > 100, `expected the source to reference many strings, found ${referenced.size}`);

  /*
   * The assertion is against the **injected** block, not the catalogue, and that distinction is the
   * whole point. Every runtime call site passes a `js.`-prefixed key; the catalogue is keyed the same
   * way; but `runtimeStrings()` used to strip that prefix before injection, so the catalogue test the
   * other way round would pass while every string on the page rendered as a raw key name.
   *
   * So: whatever a script writes must survive the whole pipeline — catalogue → runtimeStrings → the
   * `#ui-strings` block a browser actually reads. Checking the catalogue alone would have signed off
   * on a broken site.
   */
  const injected = runtimeStrings(EN_CATALOG);
  const missing = [];
  for (const [key, file] of referenced) {
    const where = file.replace(projectRoot, '').replace(/\\/g, '/');
    if (key.startsWith('js.')) {
      if (injected[key] === undefined) missing.push(`${key} (${where}) is missing from the injected catalogue`);
    } else if (EN_CATALOG[key] === undefined) {
      missing.push(`${key} (${where}) has no catalogue entry`);
    }
  }
  assert.deepEqual(missing, [], 'a referenced string renders its own key name on the page');

  // And the injected block carries nothing a script cannot reach: no `ui.` string belongs in the
  // runtime payload, and every key in it is intact.
  assert.deepEqual(
    Object.keys(injected).filter((key) => EN_CATALOG[key] === undefined),
    [],
  );
  for (const key of Object.keys(injected)) assert.ok(key.startsWith('js.'), key);
});

test('no user-visible label is written into the page as an English literal', () => {
  /*
   * The complement of the test above. A script that writes `'Waiting'` into a status cell never asks
   * the catalogue for anything, so no other check can see it — the key-existence test has nothing to
   * resolve, the audits read generated HTML, and the Arabic-ness test only reads Arabic *values*.
   *
   * That is not hypothetical. `convert-image.js` shipped an English "Waiting" in every queued batch
   * row and `crop-image.js` an English "Download 4 KB" on the primary button, both visible on Arabic
   * pages, with the whole suite and both audits green. Both were found by hand, after cropping a
   * photo on `/ar/tools/crop-image/` and reading the button.
   *
   * Only literals assigned *directly* to a user-visible property are examined. A composed value like
   * `${formatBytes(size)}` is fine — its words come from the catalogue — so template literals are
   * deliberately out of scope here.
   */
  const ALLOWED_LITERALS = new Set([
    'true', 'false', 'ltr', 'rtl', 'polite', 'assertive', 'button', 'dialog', 'none',
  ]);
  const pattern =
    /(?:textContent|innerText|placeholder|ariaLabel)\s*=\s*(['"])([^'"\n]{2,})\1|\.title\s*=\s*(['"])([^'"\n]{2,})\3|setAttribute\(\s*['"](?:aria-label|title|placeholder|alt)['"]\s*,\s*(['"])([^'"\n]{2,})\5/g;

  const findings = [];
  for (const file of filesUnder(join(srcDir, 'assets', 'js'), ['.js'])) {
    const where = file.replace(projectRoot, '').replace(/\\/g, '/');
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      const value = match[2] ?? match[4] ?? match[6];
      if (ALLOWED_LITERALS.has(value)) continue;
      if (!/[A-Za-z]{3}/.test(value)) continue;
      findings.push(`${where}: \"${value}\"`);
    }
  }
  assert.deepEqual(findings, [], 'these labels stay English on an Arabic page');
});

test('no user-visible text is composed from English words inside a template literal', () => {
  /*
   * The test above only sees a string assigned straight to a property. It cannot see text assembled
   * from a template, and that gap shipped English onto Arabic pages twice: `convert-image` and
   * `resize-image` announced “تم — 1 converted.” / “تم — 1 resized.” after a batch, and all four
   * batch tools labelled their progress bars “Progress for <file>” for screen readers. The
   * catalogue had the right words the whole time — `js.convert.convertedCount`,
   * `js.resize.resizedCount`, `js.common.progressFor`, `js.common.progressPercent` — and nothing
   * asked for them, which is why the English words were invisible to every other check.
   *
   * Shapes scanned, all of them user-facing:
   *   announce(`…`), parts.push(`…`), progress.set(ratio, `…`),
   *   el.textContent / .placeholder / .title / .innerText = `…`,
   *   el.setAttribute('aria-label' | 'title' | 'placeholder' | 'alt', `…`),
   *   and a `||` / `??` fallback that contains a space (one word is an option id: `?? 'normal'`).
   *
   * `core/` and `workers/` are out of scope deliberately: the engines throw English error messages
   * that `localizeError()` translates at the UI layer (`js.error.*`), and the enhance engine pushes
   * CSS filter strings such as `brightness(1.05)`.
   */
  const ALLOWED = new Set([
    // order-list.js's own defaults, for a caller that passes no labels. Nothing in this project
    // calls it that way — image-to-pdf passes the `js.order.*` strings — and the component keeps
    // defaults rather than throwing, so these are unreachable from any page.
    'Move up',
    'Move down',
    'Move to start',
    'Move to end',
    'Remove',
  ]);

  const patterns = [
    [/(?:announce|push|set)\s*\(\s*(?:[^,()]*,\s*)?(`[^`]*`)/g, 'a composed message'],
    [/\.(?:textContent|placeholder|title|innerText)\s*=\s*(`[^`]*`)/g, 'a text assignment'],
    [/setAttribute\(\s*['"](?:aria-label|title|placeholder|alt)['"]\s*,\s*(`[^`]*`)/g, 'a label attribute'],
    [/(?:\|\||\?\?)\s*(['"][^'"\n]*['"])/g, 'a fallback string'],
  ];

  const findings = [];
  for (const dir of ['tools', 'ui']) {
    for (const file of filesUnder(join(srcDir, 'assets', 'js', dir), ['.js'])) {
      const where = file.replace(projectRoot, '').replace(/\\/g, '/');
      const source = readFileSync(file, 'utf8');
      for (const [pattern, kind] of patterns) {
        for (const match of source.matchAll(pattern)) {
          const literal = match[1];
          const words = literal.replace(/\$\{[^}]*\}/g, ' ').trim().replace(/^['"`]|['"`]$/g, '');
          if (ALLOWED.has(words)) continue;
          if (kind === 'a fallback string' && !/\s/.test(words)) continue;
          const english = literal.replace(/\$\{[^}]*\}/g, ' ').match(/[A-Za-z]{3,}/g) ?? [];
          if (english.length === 0) continue;
          const line = source.slice(0, match.index).split('\n').length;
          findings.push(`${where}:${line} ${kind}: ${words.slice(0, 60)}`);
        }
      }
    }
  }
  assert.deepEqual(findings, [], 'these render English on a translated page — route them through t()');
});

test('every error code an engine throws has a translated message', () => {
  /*
   * `localizeError()` looks up `js.error.<CODE>` and falls back to the engine's English sentence.
   * The fallback is deliberate — it keeps an unmapped code readable — but it also means a missing
   * entry is silent, so the codes are enumerated here instead of discovered in production.
   */
  const codes = new Set();
  for (const file of filesUnder(join(srcDir, 'assets', 'js', 'core'), ['.js'])) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:new [A-Za-z]*Error|code:)\s*\(\s*'([A-Z][A-Z0-9_]*)'/g)) {
      codes.add(match[1]);
    }
  }

  assert.ok(codes.size > 10, `expected the engines to define many codes, found ${codes.size}`);
  assert.deepEqual(
    [...codes].filter((code) => EN_CATALOG[`js.error.${code}`] === undefined),
    [],
  );
});

test('every resize preset has a catalogue label', () => {
  // The runtime builds these keys from the preset id (`js.preset.${id}`), so a new preset without a
  // string would render as `js.preset.new-thing` in a dropdown.
  const missing = RESIZE_PRESETS.filter((preset) => EN_CATALOG[`js.preset.${preset.id}`] === undefined);
  assert.deepEqual(missing.map((preset) => preset.id), []);
});

test('the Arabic catalogue mirrors the English one exactly', () => {
  /*
   * A missing Arabic key is not an error anywhere in the build — `mergeStrings()` warns and the
   * English string renders. On an Arabic page that is a stray English sentence in the middle of
   * Arabic text, so it is asserted here rather than tolerated. An extra key is the opposite bug: a
   * string that lists itself as translated when nothing in the default locale ever asked for it.
   */
  const missing = Object.keys(EN_CATALOG).filter((key) => AR_CATALOG[key] === undefined);
  const extra = Object.keys(AR_CATALOG).filter((key) => EN_CATALOG[key] === undefined);
  assert.deepEqual(missing, [], 'Arabic leaves fall back to English');
  assert.deepEqual(extra, [], 'Arabic lists strings the default locale does not have');
  assert.equal(Object.keys(AR_CATALOG).length, Object.keys(EN_CATALOG).length);
});

test('every Arabic string is actually Arabic', () => {
  /*
   * The completeness test above cannot see the most likely translation mistake: pasting the English
   * string into the Arabic file under the right key. Stripping markup, HTML entities and
   * `{placeholders}` leaves only the words the translator wrote, and any Latin word left over must be
   * on the allowlist of names that are supposed to stay Latin.
   */
  const offenders = [];
  for (const [key, value] of Object.entries(AR_CATALOG)) {
    const prose = value
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-zA-Z]+;/g, ' ')
      .replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/g, ' ');
    for (const word of prose.match(/[A-Za-z][A-Za-z0-9.+#-]{2,}/g) ?? []) {
      const token = word.replace(/[.,;:]+$/, '');
      if (!LATIN_ALLOWLIST.has(token)) offenders.push(`${key}: ${token}`);
    }
  }
  assert.deepEqual(offenders, [], 'add the token to LATIN_ALLOWLIST if it is a name that must stay Latin');
});

test('the shared markup helpers are handed every string they need, in both languages', () => {
  /*
   * A helper with an English default is an English leak waiting to happen. `acceptHint()` used to
   * read `strings.template ?? '{formats} up to {size}'`, and `chromeStrings()` never supplied
   * `template` — so the Arabic dropzone read "JPEG وPNG وWebP up to 50 ميجابايت": one English phrase,
   * from a catalogue entry (`ui.shell.acceptHint`) that existed and nothing ever read.
   *
   * Per-key non-emptiness is what catches that: a helper key that is `undefined` is a helper running
   * on its own English default.
   */
  const needed = [
    'faqHeading',
    'relatedHeading',
    'guidesHeading',
    'comingSoon',
    'noLiveTools',
    'conjunction',
    'separator',
    'unit',
    'template',
  ];

  for (const locale of [null, 'ar']) {
    const strings = chromeStrings(loadUi(locale));
    const blank = needed.filter((key) => typeof strings[key] !== 'string' || strings[key].trim() === '');
    assert.deepEqual(blank, [], `chromeStrings(${locale ?? 'en'}) leaves these on their English default`);
  }

  // The English hint is the sentence the hardcoded fallback used to produce, so this also pins the
  // default locale's output against accidental rewording.
  const tool = { accepts: ['image/jpeg', 'image/png', 'image/webp'], maxInputBytes: 50 * 1024 * 1024 };
  assert.equal(acceptHint(tool, chromeStrings(loadUi())), 'JPEG, PNG or WebP up to 50 MB');

  // And the Arabic one contains no Latin word that is not a format or product name.
  const arabic = acceptHint(tool, chromeStrings(loadUi('ar')));
  const offenders = (arabic.match(/[A-Za-z][A-Za-z0-9.+#-]{2,}/g) ?? []).filter(
    (word) => !LATIN_ALLOWLIST.has(word.replace(/[.,;:]+$/, '')),
  );
  assert.deepEqual(offenders, [], `"${arabic}" still carries English`);
  // The Arabic list separator is the Arabic comma, not the Latin one.
  assert.ok(arabic.includes('JPEG\u060c PNG'), arabic);
  assert.ok(!/JPEG,\s/.test(arabic), arabic);
});

test('the runtime accessor substitutes, and says the key when a string is absent', () => {
  const t = createStrings({ 'js.common.savedFile': 'Saved {name} ({size}).' });

  assert.equal(t('js.common.savedFile', { name: 'photo.jpg', size: '96 KB' }), 'Saved photo.jpg (96 KB).');
  // Repeating a variable is allowed, which is what makes RTL word order expressible in one string.
  assert.equal(createStrings({ 'a.b': '{word} and {word}' })('a.b', { word: 'x' }), 'x and x');
  // A missing variable stays visible rather than blanking: a page that reads `Saved {name}.` is a
  // bug report, while `Saved ().` is one nobody files.
  assert.equal(interpolate('Saved {name}.', {}), 'Saved {name}.');
  // An unknown key returns itself, so a typo shows up on screen instead of as an empty label.
  assert.equal(t('js.common.nothingHere'), 'js.common.nothingHere');
  // A non-string value cannot be interpolated, so it is treated as absent rather than coerced.
  assert.equal(createStrings({ 'a.b': 42 })('a.b'), 'a.b');
});

test('Arabic publishes its own routes and no others, and English pages do not claim it', () => {
  /*
   * The publish list is a hard boundary, not a preference: `alternateLinks` only emits an Arabic
   * alternate for a route Arabic actually has. The English twin of an English-only page must not
   * advertise `/ar/`, because an hreflang pair is a promise both pages exist.
   */
  const site = loadSite();
  assert.deepEqual(site.locales.map((locale) => locale.code), ['en', 'ar']);
  assert.deepEqual(site.locales.map((locale) => locale.dir), ['ltr', 'rtl']);
  assert.equal(site.defaultLocale, 'en');

  // The published Arabic tool set is exactly the tools whose content/ar overlay publishes them, so
  // adding a fourth is a content change and nothing here has to change with it.
  const arabicTools = loadTools('ar');
  assert.ok(arabicTools.length > 0, 'Arabic publishes at least one tool');
  for (const tool of arabicTools) {
    const englishTwin = loadTools().find((candidate) => candidate.id === tool.id);
    assert.ok(englishTwin, `${tool.id} is a translation of a real tool, not a new one`);
  }

  // The two published tool routes advertise each other, with x-default pointing at English.
  const alternates = hreflangsFor(site, '/tools/compress-image/');
  assert.deepEqual(alternates, [
    'en https://browserimageeditor.online/tools/compress-image/',
    'ar https://browserimageeditor.online/ar/tools/compress-image/',
    'x-default https://browserimageeditor.online/tools/compress-image/',
  ]);

  // An untranslated route has no Arabic alternate at all. Remove Background is the one tool left
  // without an Arabic page, so it is the route that proves the publish list still has a boundary.
  // A route that *is* translated is checked the other way round, above.
  const untranslated = hreflangsFor(site, '/tools/remove-background/');
  assert.ok(!untranslated.some((entry) => entry.startsWith('ar ')), untranslated.join(', '));

  // And the prefixed path of an Arabic page is the English path plus the prefix — the URL shape the
  // phase asked for, checked rather than assumed.
  assert.equal(localePath(site, 'ar', '/tools/compress-image/'), '/ar/tools/compress-image/');
});

/** `hreflang href` strings for a route, in the order the generator emits them. */
function hreflangsFor(site, path) {
  return alternateLinks(site, path).map((entry) => `${entry.hreflang} ${entry.href}`);
}
