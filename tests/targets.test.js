/**
 * Target-page tests: the hard content gate, the pre-set default options, and the pages themselves.
 *
 * Two kinds of check live here. The first half breaks one thing at a time against the pure
 * validators, so every failure mode is exercised without editing a real content file. The second
 * half audits the real content/targets.json and the real generated pages under src/targets/, which
 * is what turns "none of them is under 250 words" into an assertion rather than a promise.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  ContentError,
  MIN_UNIQUE_WORDS,
  countWords,
  loadSite,
  loadTargets,
  loadTools,
  loadUi,
  parseUniqueContent,
  projectRoot,
  validateTargets,
} from '../scripts/lib/content.mjs';
import { escapeHtml } from '../scripts/lib/render.mjs';
import {
  describeDefaultOption,
  missingOptionStrings,
  optionStrings,
  uniqueContentHtml,
} from '../scripts/lib/tool-page.mjs';

const tools = loadTools();
const targets = loadTargets(tools);
const toolById = new Map(tools.map((tool) => [tool.id, tool]));

/** Enough words to clear the gate, so a test can then break exactly one other thing. */
function words(count) {
  return Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
}

const LONG_CONTENT = Array.from(
  { length: 40 },
  (_, index) => `Paragraph ${index + 1} exists so this entry clears the content gate on its own merits.`,
).join(' ');

function target(overrides = {}) {
  return {
    slug: 'sample-target',
    parentToolId: 'compress',
    status: 'live',
    navLabel: 'Sample target',
    title: 'A sample target page',
    description: 'A sample description long enough to be realistic.',
    h1: 'A sample target heading',
    intro: 'A sample intro.',
    targetKeyword: 'sample target keyword',
    keywords: ['sample target keyword'],
    defaultOption: { targetSizeKB: 100 },
    uniqueContent: LONG_CONTENT,
    ...overrides,
  };
}

/* ---------- the content gate ---------- */

test('countWords counts prose, not markup', () => {
  assert.equal(countWords('one two three'), 3);
  assert.equal(countWords('  one   two \n\n three  '), 3, 'ragged whitespace is not words');
  assert.equal(countWords('## A heading here'), 3, 'the "## " marker is syntax, not a word');
  assert.equal(countWords('- a bullet line'), 3, 'the "- " marker is syntax, not a word');
  assert.equal(countWords(''), 0);
});

test('an entry under the word minimum is refused, and the message says which one and by how much', () => {
  const short = MIN_UNIQUE_WORDS - 1;
  assert.throws(
    () => validateTargets([target({ uniqueContent: words(short) })], tools),
    (error) => {
      assert.ok(error instanceof ContentError);
      assert.match(error.message, /content\/targets\.json\[0\]/, 'the message names the entry');
      assert.match(error.message, new RegExp(`"uniqueContent" is ${short} words`));
      assert.match(error.message, new RegExp(`at least ${MIN_UNIQUE_WORDS} words`));
      return true;
    },
  );

  // The boundary itself has to pass, or the gate is off by one and every entry pays for it.
  const [parsed] = validateTargets([target({ uniqueContent: words(MIN_UNIQUE_WORDS) })], tools);
  assert.equal(parsed.uniqueContentWords, MIN_UNIQUE_WORDS);
});

test('uniqueContent markup has to be well formed, or the page would half-render', () => {
  const cases = [
    ['a heading with prose after it', '## A heading\nthen prose on the same block'],
    ['a list with a prose line', '- first item\nprose that is not a bullet'],
    ['a bullet that starts mid-paragraph', 'prose first\n- then a bullet'],
  ];

  for (const [name, block] of cases) {
    assert.throws(
      () => validateTargets([target({ uniqueContent: `${LONG_CONTENT}\n\n${block}` })], tools),
      (error) => error instanceof ContentError && /"uniqueContent" is malformed/.test(error.message),
      name,
    );
  }

  const [parsed] = validateTargets(
    [
      target({
        uniqueContent: `${LONG_CONTENT}\n\n## A heading\n\n- first item\n- second item`,
      }),
    ],
    tools,
  );
  assert.deepEqual(
    parsed.uniqueContentBlocks.map((block) => block.type),
    ['p', 'h2', 'ul'],
  );
});

test('an unverified marker is refused on a live entry, anywhere it appears', () => {
  const marker = 'the figure is [VERIFY] pending.';
  const cases = [
    ['uniqueContent', { uniqueContent: `${LONG_CONTENT} ${marker}` }],
    ['title', { title: `A title ${marker}` }],
    ['description', { description: `A description ${marker}` }],
    ['faq[0].a', { faq: [{ q: 'A question?', a: `An answer ${marker}` }] }],
  ];

  for (const [field, overrides] of cases) {
    assert.throws(
      () => validateTargets([target(overrides)], tools),
      (error) => {
        assert.ok(error instanceof ContentError);
        assert.ok(
          error.message.includes(`"${field}" still contains [VERIFY]`),
          `expected the failure to name ${field}, got: ${error.message}`,
        );
        return true;
      },
      `${field} must not publish an unverified claim`,
    );
  }

  // A parked draft is allowed to carry the marker: its page is not generated at all.
  const [parked] = validateTargets([target({ status: 'planned', uniqueContent: `${LONG_CONTENT} ${marker}` })], tools);
  assert.ok(parked.uniqueContent.includes('[VERIFY]'));
});

test('two target pages cannot chase the same query', () => {
  assert.throws(
    () => validateTargets([target(), target({ slug: 'another-target' })], tools),
    (error) => error instanceof ContentError && /duplicate target keyword/.test(error.message),
  );
});

/* ---------- the pre-set option ---------- */

test('a default option has to be an option the parent tool actually has', () => {
  assert.throws(
    () => validateTargets([target({ defaultOption: { quality: 80 } })], tools),
    (error) => {
      assert.ok(error instanceof ContentError);
      assert.match(error.message, /"quality" is not an option of tool "compress"/);
      assert.match(error.message, /targetSizeKB/, 'the message lists what is allowed instead');
      return true;
    },
  );

  assert.throws(
    () => validateTargets([target({ parentToolId: 'crop', defaultOption: { width: 800 } })], tools),
    /"width" is not an option of tool "crop"/,
  );
});

test('default option values are type-checked against the real option lists', () => {
  const cases = [
    ['a string where a number belongs', { targetSizeKB: '100' }, /must be a positive integer/],
    ['zero', { targetSizeKB: 0 }, /must be a positive integer/],
    ['a fractional size', { targetSizeKB: 12.5 }, /must be a positive integer/],
    ['an empty option set', {}, /must set at least one option/],
  ];

  for (const [name, defaultOption, pattern] of cases) {
    assert.throws(
      () => validateTargets([target({ defaultOption })], tools),
      (error) => error instanceof ContentError && pattern.test(error.message),
      name,
    );
  }

  assert.throws(
    () => validateTargets([target({ parentToolId: 'resize', defaultOption: { presetId: 'not-a-preset' } })], tools),
    (error) =>
      error instanceof ContentError &&
      /must be an id from RESIZE_PRESETS/.test(error.message) &&
      /instagram-square/.test(error.message),
    'an unknown preset id names the real ids in the error',
  );

  assert.throws(
    () =>
      validateTargets(
        [target({ parentToolId: 'resize', defaultOption: { presetId: 'hd-1080p', width: 1920, height: 1080 } })],
        tools,
      ),
    /cannot set "presetId" together with "width"\/"height"/,
  );

  assert.throws(
    () => validateTargets([target({ parentToolId: 'convert', defaultOption: { outputMime: 'image/avif' } })], tools),
    /must be one of the tool's own outputs \(image\/webp, image\/png, image\/jpeg\)/,
  );

  assert.throws(
    () => validateTargets([target({ parentToolId: 'image-to-pdf', defaultOption: { pageSizeId: 'legal' } })], tools),
    /must be an id from PAGE_SIZES/,
  );
});

test('every tool accepts the defaults its own targets need', () => {
  const cases = [
    ['compress', { targetSizeKB: 200 }],
    ['resize', { presetId: 'instagram-portrait' }],
    ['resize', { width: 1280, height: 720 }],
    ['convert', { outputMime: 'image/png' }],
    ['crop', { ratioId: 'wide' }],
    ['image-to-pdf', { pageSizeId: 'a4', marginId: 'normal', qualityId: 'balanced' }],
  ];

  for (const [parentToolId, defaultOption] of cases) {
    const [parsed] = validateTargets([target({ parentToolId, defaultOption })], tools);
    assert.deepEqual(parsed.defaultOption, defaultOption, `${parentToolId} keeps its defaults verbatim`);
  }
});

test('the default is described in words a page can show', () => {
  const cases = [
    [{ targetSizeKB: 100 }, '100 KB'],
    [{ presetId: 'instagram-square' }, '1080 × 1080'],
    [{ width: 1280, height: 720 }, '1280 × 720'],
    [{ outputMime: 'image/jpeg' }, 'JPEG'],
    [{ ratioId: 'wide' }, '16:9'],
    [{ pageSizeId: 'match' }, 'Match each image'],
    [{ pageSizeId: 'a4', marginId: 'normal', qualityId: 'balanced' }, 'A4'],
  ];

  for (const [defaultOption, expected] of cases) {
    const summary = describeDefaultOption(defaultOption);
    assert.ok(summary.includes(expected), `"${summary}" should mention ${expected}`);
    assert.ok(summary.length > 5, 'a description is never empty');
  }
});

/* ---------- rendering ---------- */

test('uniqueContent is rendered as prose, and anything tag-shaped in it stays text', () => {
  const blocks = parseUniqueContent(
    `Plain paragraph with <script>alert(1)</script> in it.\n\n## A heading\n\n- first\n- second`,
  );
  const html = uniqueContentHtml(blocks);

  assert.ok(!html.includes('<script>'), 'markup in content must be escaped, not rendered');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<h2>A heading</h2>'));
  assert.ok(html.includes('<li>first</li>'));
  assert.ok(html.includes('data-unique-content'));
});

/* ---------- the real content and the real pages ---------- */

test('every target in content/targets.json clears the word gate on its own', () => {
  assert.ok(targets.length >= 10, 'phase 4 asks for 10 to 15 real entries');

  for (const entry of targets) {
    // Counted independently of countWords(), so a bug in the gate's own counter cannot hide a
    // short entry from the audit.
    const tokens = entry.uniqueContent.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
    assert.ok(
      tokens.length >= MIN_UNIQUE_WORDS,
      `target "${entry.slug}" has ${tokens.length} words of unique content`,
    );
    assert.ok(toolById.has(entry.parentToolId), `target "${entry.slug}" must have a parent tool`);
    assert.ok(Object.keys(entry.defaultOption).length > 0, `target "${entry.slug}" must be pre-set`);
    assert.ok(entry.faq.length >= 3, `target "${entry.slug}" should answer its own questions`);
  }
});

test('no two targets share a sentence or a question — the content is genuinely its own', () => {
  const sentences = new Map();
  const questions = new Map();

  for (const entry of targets) {
    const prose = [entry.uniqueContent, ...entry.faq.flatMap((item) => [item.q, item.a])].join(' ');

    for (const sentence of prose.split(/(?<=[.!?])\s+/)) {
      const wordsInSentence = sentence.replace(/\s+/g, ' ').trim().split(' ').length;
      // Short fragments are allowed to repeat; a whole repeated sentence is filler.
      if (wordsInSentence < 8) continue;
      const key = sentence.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      const previous = sentences.get(key);
      assert.equal(
        previous,
        undefined,
        `"${entry.slug}" repeats a sentence from "${previous}": ${sentence.trim().slice(0, 80)}`,
      );
      sentences.set(key, entry.slug);
    }

    for (const item of entry.faq) {
      const key = item.q.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      assert.equal(questions.get(key), undefined, `"${entry.slug}" repeats a FAQ question`);
      questions.set(key, entry.slug);
    }
  }
});

test('every generated target page is the parent tool, pre-configured', () => {
  for (const entry of targets) {
    const parent = toolById.get(entry.parentToolId);
    const file = resolve(projectRoot, 'src', 'targets', entry.slug, 'index.html');
    let html;
    try {
      html = readFileSync(file, 'utf8');
    } catch {
      assert.fail(`src/targets/${entry.slug}/index.html is missing — run "npm run gen"`);
    }

    assert.ok(
      html.includes(`<link rel="canonical" href="https://example.com/targets/${entry.slug}/">`) ||
        html.includes(`<link rel="canonical" href="${entry.slug}">`) ||
        /<link rel="canonical" href="https?:\/\/[^"]+\/targets\//.test(html),
      `${entry.slug}: a canonical tag pointing at its own URL`,
    );
    assert.ok(html.includes(`href="/tools/${parent.slug}/"`), `${entry.slug}: links back to its parent tool`);
    assert.ok(
      html.includes(`src="/assets/js/tools/${parent.slug}.js"`),
      `${entry.slug}: loads the parent tool's own script, not a copy`,
    );
    assert.ok(html.includes('data-tool-root'), `${entry.slug}: renders the parent's working panel`);
    assert.ok(html.includes('data-unique-content'), `${entry.slug}: carries its own content block`);
    assert.ok(html.includes('data-faq'), `${entry.slug}: carries its own FAQ block`);
    assert.ok(html.includes('data-parent-tool-cta'), `${entry.slug}: carries the parent call to action`);

    // The whole point of the page: the panel arrives with the target's default in it.
    const config = JSON.parse(/<script type="application\/json" id="tool-config">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.deepEqual(config.defaults, entry.defaultOption, `${entry.slug}: the panel is pre-set`);

    // And the page's own prose is what was written, not a stub. Compared in its escaped form,
    // because an apostrophe in the content is escaped on the way into the markup.
    const paragraph = entry.uniqueContent.split('\n\n')[0].split('\n')[0];
    assert.ok(
      html.includes(escapeHtml(paragraph)),
      `${entry.slug}: its first paragraph is on the page`,
    );
  }
});

/**
 * The "pre-set for you" sentence every target page opens with.
 *
 * It used to be assembled from English phrases hardcoded in `tool-page.mjs`. Translating the copy
 * was not enough to translate the sentence: the phrases had to move into the catalogue too, and a
 * locale missing one falls back to English *per phrase* — so an Arabic page would read «مهيّأة لك
 * مسبقاً: a 100 KB target file size per image» with every other check green, because the fallback is
 * exactly what makes the English words look legitimate. Hence both directions here: the phrase list
 * is complete for every configured locale, and the default locale's sentences are pinned to the
 * words that shipped before the phrases moved.
 */
test('the pre-set summary is translated phrase by phrase, and English did not move', () => {
  const site = loadSite();
  const english = loadTargets(tools).filter((entry) => entry.status === 'live');
  for (const locale of site.locales) {
    const missing = missingOptionStrings(loadUi(locale.code));
    assert.deepEqual(
      missing,
      [],
      `content/${locale.code}/ui.json leaves these summary phrases in English`,
    );
  }

  // The default locale's sentences, one per option kind a target can pre-set. These are what the
  // live English target pages said before the phrases were extracted, byte for byte.
  assert.equal(describeDefaultOption({ targetSizeKB: 100 }), 'a 100 KB target file size per image');
  assert.equal(describeDefaultOption({ width: 1280, height: 720 }), '1280 × 720 pixels');
  assert.equal(describeDefaultOption({ outputMime: 'image/png' }), 'PNG output');
  assert.equal(describeDefaultOption({ ratioId: 'square' }), '1:1 aspect ratio');
  assert.equal(
    describeDefaultOption({ pageSizeId: 'a4', marginId: 'normal', qualityId: 'balanced' }),
    'A4 (210 × 297 mm) page size, normal (0.5 in) page margins, Balanced (JPEG 85%)',
  );
  // "None margins" is not English, so the empty margin case has its own phrasing.
  assert.equal(describeDefaultOption({ pageSizeId: 'match', marginId: 'none' }), 'Match each image page size, no page margins');
  assert.equal(describeDefaultOption({ presetId: 'instagram-square' }), 'Square post preset (1080 × 1080 px)');
  assert.equal(describeDefaultOption({}), 'the suggested settings');

  // English joins with a Latin comma; a translated locale uses its own separator.
  assert.equal(describeDefaultOption({ pageSizeId: 'a4', qualityId: 'high' }).split(' page size')[1][0], ',');

  // Every translated sentence is translated all the way through: the phrases come from that
  // locale's catalogue, and the only Latin left is names that stay Latin.
  const arabic = optionStrings(loadUi('ar'));
  const localeTargets = loadTargets(loadTools('ar'), 'ar');
  assert.equal(localeTargets.length, english.length);
  localeTargets.forEach((entry, index) => {
    const sentence = describeDefaultOption(entry.defaultOption, arabic);
    assert.match(sentence, /[\u0600-\u06FF]/, `"${sentence}" is not Arabic`);

    // The list separator is the locale's own: an English sentence with two clauses must become an
    // Arabic one that uses the Arabic comma and no Latin one.
    const clauses = describeDefaultOption(english[index].defaultOption).split(', ').length;
    assert.equal(
      sentence.split('\u060C ').length,
      clauses,
      `"${sentence}" has a different number of clauses than its English twin`,
    );
    assert.ok(!/, \S/.test(sentence), `"${sentence}" joins its clauses with a Latin comma`);

    const stripped = sentence.replace(
      /A4|JPEG|PNG|WebP|US Letter|KB|MB|px|mm|in|×|\d|\(|\)|%|:|\u060C|\.| /g,
      ' ',
    );
    const leftover = stripped.match(/[A-Za-z]{3,}/g) ?? [];
    assert.deepEqual(leftover, [], `"${sentence}" still carries an English clause`);
  });
});

/**
 * Vocabulary that is *supposed* to stay Latin in Arabic copy: formats, brands, units and the site's
 * own name. Kept explicit, exactly like `tests/i18n.test.js`'s list, so a new token is a decision
 * rather than an accident.
 */
const ARABIC_TARGET_LATIN = new Set([
  'a4', 'ai', 'android', 'apple', 'avif', 'canvas', 'chrome', 'css', 'edge', 'firefox', 'gb',
  'heic', 'heif', 'html', 'imagetools', 'in', 'instagram', 'ios', 'iphone', 'jpeg', 'jpg', 'kb',
  'lanczos', 'letter', 'mb', 'mm', 'pdf', 'png', 'px', 'safari', 'seo', 'url', 'us', 'webp',
  'windows', 'worker', 'workers', 'zip',
]);

/**
 * The 14 target pages, in Arabic.
 *
 * The point of these 14 pages is that they are not the English ones under another URL, and no
 * mechanical check can see the difference — so what is checked here is the part that can be: every
 * English entry has an Arabic twin with the same slug, the same parent tool and the same number of
 * answers; its prose is its own and clears the same word gate; and the Latin left in it is limited
 * to vocabulary that is supposed to stay Latin.
 */
test('every English guide has an Arabic twin, with its own prose and no English left in it', () => {
  const english = loadTargets(tools).filter((entry) => entry.status === 'live');
  const arabic = loadTargets(loadTools('ar'), 'ar');

  // Same slugs, one for one: a translated set that quietly dropped one is the failure this catches.
  assert.deepEqual(
    arabic.map((entry) => entry.slug),
    english.map((entry) => entry.slug),
    'the Arabic guides are exactly the English ones',
  );

  for (const entry of arabic) {
    const source = english.find((candidate) => candidate.slug === entry.slug);
    assert.ok(source, `${entry.slug} mirrors a real English guide`);
    assert.equal(entry.parentToolId, source.parentToolId, `${entry.slug} keeps its parent tool`);
    assert.equal(entry.faq.length, source.faq.length, `${entry.slug} answers the same number of questions`);
    assert.equal(
      entry.defaultOption && Object.keys(entry.defaultOption).length,
      source.defaultOption && Object.keys(source.defaultOption).length,
      `${entry.slug} pre-sets the same options`,
    );
    assert.notEqual(entry.uniqueContent, source.uniqueContent, `${entry.slug} is not the English prose`);
    assert.notEqual(entry.title, source.title, `${entry.slug} has its own title`);

    // The gate the build enforces, asserted against the loaded value rather than trusted.
    assert.ok(
      entry.uniqueContentWords >= MIN_UNIQUE_WORDS,
      `${entry.slug} carries ${entry.uniqueContentWords} Arabic words, under the ${MIN_UNIQUE_WORDS} minimum`,
    );

    const prose = [
      entry.title,
      entry.description,
      entry.h1,
      entry.intro,
      entry.navLabel,
      entry.uniqueContent,
      ...entry.faq.flatMap((item) => [item.q, item.a]),
    ].join(' ');
    const latin = [
      ...new Set(
        prose
          // Sizes and resolutions are written the way the glossary says: 1080x1080, 720p, 16:9.
          .replace(/\b\d+\s*[x×]\s*\d+\b/g, ' ')
          .replace(/\b\d+p\b/g, ' ')
          .match(/[A-Za-z][A-Za-z0-9.+#-]*/g) ?? [],
      ),
    ].filter((word) => !ARABIC_TARGET_LATIN.has(word.replace(/[.,;:]+$/, '').toLowerCase()));
    assert.deepEqual(latin, [], `${entry.slug} leaves these English words behind`);
    assert.match(prose, /[\u0600-\u06FF]{3}/, `${entry.slug} reads as Arabic`);
  }
});
