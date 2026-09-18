# Translations

What is translated, what is not, and — the part that matters most — **who wrote the Arabic**.

Last updated: 2026-09-18.

---

## Read this first: the Arabic was written by an AI, and nobody has reviewed it

Every Arabic string on this site was produced by an AI agent — the Phase 8 build, the Phase 9 tool that
added its own strings, and Gate A, which added the six standalone pages and three more tools. No native
speaker wrote any of it, and no native speaker has read any of it. In the sense that matters legally
and editorially, this is **machine translation**.

The site does not hide that. Every Arabic page carries a visible, translated notice
(`ui.chrome.translationNotice` in `content/ar/ui.json`):

> هذه النسخة العربية مترجمة آلياً ولم يراجعها متحدث أصلي بعد. وإذا بدت عبارة ما غير مألوفة، فالصفحة الإنجليزية هي الأصل.

A build gate in `scripts/audit-seo.mjs` fails the build if that notice disappears from an Arabic page
or loses its catalogue entry, so the disclosure cannot be quietly dropped later.

**Nothing here should go live as the final Arabic copy.** Treat the `/ar/` pages as a complete,
working, structurally-correct translation *draft* that a native speaker edits — not as shipped copy.

### What is genuinely reviewed, and what is only structurally verified

Honest split of what has actually been checked:

| Claim | Status |
|---|---|
| Every catalogue key has an Arabic value (no silent English fallback) | **Verified** by `tests/i18n.test.js` |
| Every Arabic value contains real Arabic prose, not pasted English | **Verified** by `tests/i18n.test.js` (allowlisted Latin names aside) |
| Arabic prose uses Arabic punctuation (`،` `؛`), never Latin `,` or `?` | **Verified** by inspection; clean, including the list separator between format names |
| Every string the interface shows at **run** time is Arabic, not a raw key name | **Verified live.** This was broken for the whole build — see "A defect this phase found" below |
| Numbers, filenames and size readouts stay correctly ordered inside RTL text | **Designed** (`unicode-bidi: isolate`), **not yet reviewed by an Arabic reader** |
| The Arabic *reads naturally* — register, idiom, tone, terminology | **Not verified by anyone.** This is the work a native speaker does |
| Arabic technical terminology is the term a Saudi/Gulf/Egyptian reader expects | **Not verified.** Terms like «عامل ويب», «مُرمِّز», «فكّ الترميز» are defensible but debatable |
| Every Arabic page has the right *structure* — `dir="rtl"`, `lang="ar"`, an Arabic canonical, reciprocal `hreflang` with its English twin, and the unreviewed-translation notice | **Verified** by `verify-gate-a-ar.mjs` against the built `dist/` tree: 13/13 pages |
| No English is left in the accessibility text either | **Verified** — the same script scans `aria-label`, `title`, `alt` and `placeholder`. It found one real defect, now fixed (`src/assets/js/ui/site.js` hardcoded "Close menu") |
| No English is left in labels that only appear *after* an interaction | **Verified by execution, and two defects were found and fixed.** Driving each Arabic tool with a real file showed `convert-image.js` writing a literal `'Waiting'` into every queued row and `crop-image.js` writing `Download 4 KB` on the primary button. Both now read the catalogue, and a new test (`no user-visible label is written into the page as an English literal`) fails on the pattern — proven by reintroducing the defect and watching it fail |
| The three Arabic tool pages translated in Gate A work end to end | **Verified by execution.** Each was driven with real files: image-to-pdf queued two photos and produced Arabic order rows and labels; crop-image cropped to «قُصّت إلى 1020×680 عند 2 KB.» and relabelled its button «تنزيل 2 KB»; enhance-photo rendered five style chips and seven thumbnails from the dropped photo. No raw key names anywhere |

### A defect this phase found, and what it says about the tests

Beyond the translation itself, walking the Arabic page in a browser found that **every runtime string in
the interface was rendering as its own key name** — `js.common.download` on each download button,
`js.common.batchQueued` in the status line — in English as well as Arabic. The catalogue was complete and
correct; the injection step stripped the `js.` prefix that all 164 call sites use, so no lookup could
succeed. A green test suite, two clean audits and 31 generated pages all agreed it was fine.

The lesson worth keeping: the markup half of the catalogue renders at build time and therefore looks
translated in any static review, while the runtime half only breaks when something interactive happens.
Loading the page and pressing a button is not optional. Details in `PROGRESS_LOG.md` → Phase 8.

### Decisions a native reviewer should overturn if they disagree

Written down because each one is a judgement call, not a fact:

1. **Western digits (`0-9`), not Eastern Arabic numerals (`٠-٩`).** Kept Western throughout. This
   matches what most Arabic web products ship and what the RTL stylesheet documents, but it is
   genuinely regional — a reviewer may want `١٠٠ كيلوبايت`, not `100 كيلوبايت`.
2. **Modern Standard Arabic only.** No dialect. Neuter, instructional register, no colloquialisms.
3. **Percentage and unit placement.** `{percent}%` keeps the `%` after the number, as in English.
4. **Latin names left Latin.** Format names, browser names and API names are never transliterated —
   see the allowlist in `tests/i18n.test.js`. The one exception to review is `ImageTools`, which is a
   placeholder product name anyway.
5. **Directional words.** «الخلفية», «يسار», «يمين» do not appear in the tool copy precisely because
   they are the phrases most likely to be wrong once mirrored. If a reviewer wants them, they need
   checking against the flipped layout, not just the sentence.
6. **One string was written after the phase that introduced this file.** `ui.tool.introSummary`
   («ما الذي تفعله هذه الأداة») is the label on the control that unfolds a tool page's intro paragraph
   on a phone; English calls it "What this tool does". It is a deliberately plain phrasing of the same
   question — a reviewer may prefer «نبذة عن الأداة» for register, and the string is a single place to
   change it.

---

## What is translated

Arabic publishes **27 of the 28 English routes** (96%), mirrored under the existing URL shape — `/ar/`
plus the English path. Every one of them is reachable, indexable, and declared with a reciprocal
`hreflang`.

| Arabic route | English twin |
|---|---|
| `/ar/` | `/` |
| `/ar/pages/about/` | `/pages/about/` |
| `/ar/pages/contact/` | `/pages/contact/` |
| `/ar/pages/how-it-works/` | `/pages/how-it-works/` |
| `/ar/pages/offline/` | `/pages/offline/` |
| `/ar/pages/privacy/` | `/pages/privacy/` |
| `/ar/pages/terms/` | `/pages/terms/` |
| `/ar/tools/compress-image/` | `/tools/compress-image/` |
| `/ar/tools/convert-image/` | `/tools/convert-image/` |
| `/ar/tools/crop-image/` | `/tools/crop-image/` |
| `/ar/tools/enhance-photo/` | `/tools/enhance-photo/` |
| `/ar/tools/image-to-pdf/` | `/tools/image-to-pdf/` |
| `/ar/tools/resize-image/` | `/tools/resize-image/` |
| `/ar/targets/compress-image-to-100kb/` | `/targets/compress-image-to-100kb/` |
| `/ar/targets/compress-image-to-200kb/` | `/targets/compress-image-to-200kb/` |
| `/ar/targets/compress-image-to-50kb/` | `/targets/compress-image-to-50kb/` |
| `/ar/targets/convert-heic-to-jpg/` | `/targets/convert-heic-to-jpg/` |
| `/ar/targets/convert-jpg-to-png/` | `/targets/convert-jpg-to-png/` |
| `/ar/targets/convert-png-to-jpg/` | `/targets/convert-png-to-jpg/` |
| `/ar/targets/convert-webp-to-jpg/` | `/targets/convert-webp-to-jpg/` |
| `/ar/targets/crop-image-to-16-9/` | `/targets/crop-image-to-16-9/` |
| `/ar/targets/crop-image-to-square/` | `/targets/crop-image-to-square/` |
| `/ar/targets/image-to-pdf-a4/` | `/targets/image-to-pdf-a4/` |
| `/ar/targets/photos-to-pdf-one-page/` | `/targets/photos-to-pdf-one-page/` |
| `/ar/targets/resize-image-for-instagram/` | `/targets/resize-image-for-instagram/` |
| `/ar/targets/resize-image-to-1080x1080/` | `/targets/resize-image-to-1080x1080/` |
| `/ar/targets/resize-image-to-1280x720/` | `/targets/resize-image-to-1280x720/` |

The files that make up the Arabic content, mirroring the English structure one directory up:

| File | What it holds |
|---|---|
| `content/ar/site.json` | Site name, tagline, description, `dir: rtl`, homepage prose |
| `content/ar/tools.json` | Title, meta description, intro, h1, FAQ and related ids for the 6 translated tools |
| `content/ar/pages.json` | Title, meta description, intro and body-file id for the 6 translated standalone pages |
| `content/ar/ui.json` | All UI strings, in parity with `content/ui.json` — every button label, status line, error message and disclosure. The handful that carry no Arabic prose are composition templates (`{count} {pages} · {size}`), numeral-only ratio labels (`1:1`, `16:9`), and the language endonym `English` |
| `content/ar/targets.json` | The 14 guide pages: title, meta description, h1, intro, nav label, keywords, target keyword, FAQ and 259–310 words of unique prose each. Each is written for its own page; none is a rephrase of the English |
| `content/ar/glossary.json` | **103 terms + 29 keep-English exceptions.** The one translation per concept, decided before any page was written — see "The glossary" below |
| `src/partials/ar/header.html`, `footer.html`, `nav-*.html`, `tool-grid.html` | The Arabic nav, footer, breadcrumb and homepage grid, generated from the Arabic content files |
| `src/templates/ar/home.html` | The Arabic homepage body |
| `src/templates/ar/pages/*.html` | Six hand-written Arabic bodies for about, contact, how-it-works, offline, privacy, terms. The English ones are `src/templates/pages/*.html`, and `readLocaleTemplate()` in `scripts/lib/render.mjs` **fails the build** when a page is published in a locale that has no body of its own — a page cannot publish Arabic chrome over an English article |

A translation file is a **publish list, not a merge**. Listing a tool in `content/ar/tools.json`
publishes its whole page, and the loader fails the build if any translatable field is missing — a
half-translated entry cannot quietly inherit English paragraphs under an Arabic URL.

## What is English-only

**1 of the 28 English routes** has no Arabic twin: the **remove-background** tool. It is not translated
by explicit owner decision — its English page is `status: "planned"`, `noindex`, out of the sitemap,
and its engine is parked. Translating a page a visitor cannot use would add an Arabic URL pointing at
"coming soon". Its page correctly declares no `hreflang="ar"`, and its language switcher links to
`/ar/` with the `ui.chrome.langFallback` tooltip rather than pretending a translation exists.

On an English-only page, the language switcher does **not** pretend an Arabic twin exists. Its Arabic
entry links to `/ar/` — the Arabic homepage — with a tooltip saying so
(`ui.chrome.langFallback`), and the page emits no `hreflang="ar"` alternate. The site audit enforces
both halves of that: a declared alternate must resolve to a real route, and it must be reciprocated
by the page it points at.

---

## Two things that are unfinished, stated plainly

**1. Arabic share cards render without their title.** `scripts/gen-og.mjs` draws every 1200×630 OG
image with the bundled IBM Plex Sans, which has **no Arabic glyphs**. The Arabic card files are
generated at the right paths, so nothing 404s and no page breaks — but the Arabic title in the image
cannot render. Fixing it means adding an Arabic-capable font, which is a licensing decision (IBM Plex
Sans Arabic is OFL, so it would likely be fine) and therefore a decision for the project owner rather
than something to slip in during a localisation phase. Until then, treat Arabic social previews as
Latin-text-only.

**2. The offline fallback page stays English.** `/pages/offline/` is shown when a visitor navigates
offline to a page the service worker has not cached. It is English-only, because the service worker
cannot know which language was being browsed when the network vanished without shipping a bilingual
page to everyone. A bilingual version is the fix if that matters; it was not built.

---

## The strings that arrived with the Photo Enhance tool

The **Photo Enhance** tool (`/tools/enhance-photo/`) shipped in Phase 9 with **61 new catalogue
strings**, and this project's rule is that the two catalogues never drift — `tests/i18n.test.js` fails
if a key exists in one and not the other, or if an Arabic value is still English. So all 61 had Arabic
values from the day they were added.

**They are no longer inert.** Gate A gave the tool an Arabic page at `/ar/tools/enhance-photo/`, so
these strings now render — and were walked in a browser rather than trusted: the five style chips, the
intensity slider, the five thumbnail previews (correctly generated from the visitor's own photo on the
Arabic page), the decode/analyse/grade/encode progress phases and the status line were all confirmed
Arabic and free of raw key names. The five style names are still a decision a reviewer should look at
first, because they are the one place where the Arabic reads as a *name* rather than an instruction:

| Group | Count | What |
|---|---|---|
| `ui.enhance.*` | 33 | The style names (Natural Pop, Vivid, Warm glow, Cool mood, Classic B&W), the intensity and advanced-slider labels, the panel headings, the five "How this works" paragraphs and the comparison labels |
| `js.enhance.*` | 27 | Every runtime status line and error message: the four progress phases, the preview states, the done/failed readouts, and the two diagnostics that explain the histogram correction in numbers |
| `js.error.INVALID_PRESET` | 1 | The error for a style that does not exist |

Two consequences worth stating rather than leaving implied:

1. **Runtime strings are only proven by using the tool.** The parity test proves a key exists in both
catalogues; it cannot prove the Arabic reaches the screen. Phase 8 shipped a defect where every runtime
string rendered as its own key name with a green test suite, and the only thing that caught it was
loading a page and pressing a button. Gate A repeated that check on the Arabic enhance page.
2. **Style names are translated, and that is a choice.** «نضارة طبيعية», «ألوان زاهية», «دفء ذهبي»,
«برودة هادئة», «أبيض وأسود كلاسيكي» are descriptive phrases, not transliterations. A reviewer may prefer
keeping the English names as product names, the way the format names are kept Latin — the five chips are
the one place in the tool where the translation is visible as a *name* rather than as an instruction.

---

## The glossary

`content/ar/glossary.json` holds **103 terms** and **29 keep-English exceptions**. It was written before
any page was translated, and it is the reason the same concept reads the same way on all 13 Arabic pages:
one word per concept, no synonyms drifting between pages. The owner-approved core is

| English | Arabic |
|---|---|
| compress | ضغط |
| resize | تغيير المقاس |
| convert | تحويل |
| crop | قص |
| remove background | إزالة الخلفية |
| enhance | تحسين |
| image / photo | صورة (one word for both — two would be exactly the synonym drift this file prevents) |
| file | ملف |
| format | صيغة |
| quality | جودة |
| download | تحميل |
| upload | رفع (used only where the English says "upload" — the site never uploads) |
| save | حفظ |
| choose | اختر |
| drop | أسقط (drag-and-drop) / ارفع (elsewhere) |
| browser | المتصفح |
| device | جهاز |
| offline | بدون اتصال |
| free | مجاني |
| private | خاص |
| no upload | بدون رفع |
| in your browser | داخل متصفحك |

**19 terms stay Latin everywhere:** WebP, JPEG, JPG, PNG, AVIF, HEIC, PDF, ZIP, AI, SEO, Web Worker,
URL, `px` (never transliterated — the word «بكسل» is reserved for the spelled-out English "pixels"),
KB, MB, GB, DPI, HTML, CSS. The 103-term list adds the rest of the repeated vocabulary — «جدول
الإخراج», «الدفعة», «الشريط», «العيّنة» and so on — each with the reason it was chosen.

## Gate A: what changed, and how the English side was checked

Gate A covered the glossary, the six standalone pages, the two tool panels whose copy was still literal
English in the template, and three more tools in `content/ar/tools.json`. The catalogue grew from **371
to 452 keys** (+81: `ui.crop.*`, `ui.pdf.*`, `js.crop.*`, `js.pdf.*`, `js.order.*`, `js.ratio.*` and two
chrome strings), all of them with Arabic values in the same commit.

**Proving the English side did not move.** The pre-gate `dist/` tree was copied aside before the first
edit, then compared against a fresh build, page by page, with chunk hashes normalised:

| Result | Pages |
|---|---|
| Visible text byte-identical to the pre-gate build | **27 of 28** |
| Visible text changed | 1 — see below |
| Differ only by added catalogue keys inside the embedded `#ui-strings` block | 19 |
| Differ by catalogue keys **and** a new direct Arabic twin link | 8 |
| Differ by catalogue keys, twin link **and** a second structural change | 1 |

There is no English page whose *byte* output is unchanged, and it would be dishonest to claim otherwise:
**every page embeds the whole string catalogue**, so adding 81 keys changes all 28 of them. On
`/pages/about/` the block grew from 13,358 to 18,340 bytes (+4,982) and the page from 25,281 to 30,279
bytes (+4,998; +1,348 gzipped, 7,892 → 9,240). Every key that existed before still exists with the same
English value — that is checked key by key, not eyeballed. The three real differences are:

1. **`pages/contact/` — the one visible English change.** The "The code" paragraph shipped its notice as
   *escaped* markup, so visitors read `<span class="page-placeholder">…</span>` as text. Moving the
   sentence into the catalogue made it real markup, and the notice now renders as intended. The words are
   unchanged; the tags stopped being visible. This is a fix, but it is a visible change to an English
   page and is recorded as such.
2. **The dropzone hint on the crop and PDF pages** now carries a literal `—` instead of the `&mdash;`
   entity. Identical rendering; noted because it is a byte-level difference.
3. **`tools/enhance-photo/`** now loads its six modules as six `<script type="module">` tags instead of
   one entry plus `modulepreload` links. That matches the other six tool pages, and the page was
   re-verified live afterwards (a dropped photo produced seven thumbnails and the five style chips).

### Three English strings Gate A found on Arabic pages — and why nothing caught them

All three are the same failure: a string that never asks the catalogue for anything, so no test, audit
or generated-HTML check can see it. They were found by using the pages.

| Where | What it said | Now | How it was found |
|---|---|---|---|
| `src/assets/js/ui/site.js` | The mobile menu button's accessible name, literally `'Close menu'` / `'Open menu'` — on **every** Arabic page | `js.chrome.menuOpen` / `js.chrome.menuClose`, whose English values are the same two strings, so an English reader sees no change; Arabic announces «افتح القائمة» / «أغلق القائمة» | Reading the accessibility tree of a live Arabic page |
| `src/assets/js/tools/convert-image.js` | `'Waiting'` in every queued batch row | `js.common.waiting` → «في الانتظار» | Dropping two files on `/ar/tools/convert-image/` |
| `src/assets/js/tools/crop-image.js` | `Download 4 KB` on the primary button, after a crop | `js.common.downloadSize` → «تنزيل 4 KB», the same key four other tools already used | Cropping a photo on `/ar/tools/crop-image/` and reading the button |

The second and third are in the two tools whose panels Gate A tokenised — the *static* part was
converted to catalogue keys and verified, while a label built at run time from a literal was not. Two
checks now exist for the pattern: `tests/i18n.test.js` fails on a literal assigned to `textContent`,
`placeholder`, `title`, or `aria-label` (proven by reintroducing `'Waiting'` and watching it fail), and
the Arabic verifier scans attributes as well as visible text.

---

## Gate B: the 14 guide pages, and the sentence that could not be translated without a code change

Gate B translated the 14 guide pages (`content/ar/targets.json`) and removed the two things that made
them impossible first.

**1. `build-targets.mjs` refused to publish a non-default locale.** The refusal was correct: a target
page opens with a *pre-set for you* sentence assembled at build time from options — and that sentence,
plus every option label inside it, was English prose living in `scripts/lib/tool-page.mjs`. Translating
the copy would have produced an Arabic page reading «مهيّأة لك مسبقاً: a 100 KB target file size per
image». Ten phrases (`ui.target.option.*`) and the separator (`ui.shell.listSeparator`, already there)
moved into the catalogue; `missingOptionStrings()` now fails the build by name if a locale that
publishes guides is missing any of them, and `tests/targets.test.js` asserts the list is empty for
every configured locale.

**2. The English wording is pinned.** `describeDefaultOption()` falls back to its English phrases *per
phrase*, which is exactly what makes a missing translation invisible — the English words look
legitimate. The test therefore also pins the default locale's eight sentence shapes byte for byte, and
the Gate B English diff confirms it on the built pages: **the pre-set sentence is byte-identical on all
14 English guide pages**, and the only lines those pages gained are the `hreflang="ar"` alternate and
the language-switcher link that now points at the Arabic twin instead of the Arabic homepage.

**The 14 pages, with their word counts.** The gate is 250 words of prose that appears nowhere else; the
build prints both locales now.

| Arabic guide | Words | English twin |
|---|---|---|
| `compress-image-to-100kb` | 310 | 400 |
| `compress-image-to-200kb` | 298 | 377 |
| `compress-image-to-50kb` | 292 | 361 |
| `resize-image-to-1080x1080` | 284 | 347 |
| `resize-image-for-instagram` | 285 | 360 |
| `resize-image-to-1280x720` | 270 | 362 |
| `convert-png-to-jpg` | 273 | 352 |
| `convert-jpg-to-png` | 293 | 326 |
| `convert-webp-to-jpg` | 292 | 329 |
| `convert-heic-to-jpg` | 270 | 332 |
| `crop-image-to-square` | 284 | 358 |
| `crop-image-to-16-9` | 276 | 345 |
| `image-to-pdf-a4` | 259 | 345 |
| `photos-to-pdf-one-page` | 272 | 353 |

Every Arabic entry is shorter than its English twin (Arabic says the same thing in fewer words) and the
narrowest is `image-to-pdf-a4` at **259** — nine words of headroom. If that page is edited, watch it.

**One sentence that needed the catalogue changed, not the copy.** Assembled, the PDF page-size
sentence read «مقاس صفحة مقاس كل صورة»: the phrase template is «مقاس صفحة {label}» and the *Match each
image* label was «مقاس كل صورة», so «مقاس» appeared twice. The label is now «مطابقة لكل صورة» (mirroring
the English "Match each image"), and the three places the Arabic prose quotes that option were updated
to match. English is untouched — its label is the constant in `engine-pdf.js`.

### Five English strings Gate B found on Arabic pages, and the check that now catches them

Gate A's lesson repeated itself on the two tools nobody had tokenised at run time. All five were found
by **using the pages in the browser**, never by a test:

| Where | What an Arabic visitor saw | Now |
|---|---|---|
| `convert-image.js` | The completion line announced **“تم — 1 converted.”** after every batch | `js.convert.convertedCount` → «{count} محوَّلة» |
| `resize-image.js` | **“تم — 1 resized.”**, and the progress line read **“1 of 3 done — 33%”** | `js.resize.resizedCount`, `js.common.progressPercent` |
| `convert-image.js`, `resize-image.js` | The batch-start announcement was the English literal, even though `js.convert.startingOne/Many` existed and was translated | those two keys |
| all four batch tools | Each photo's progress bar was announced as **“Progress for photo.jpg”** | `js.common.progressFor` → «تقدّم {name}» |
| `image-to-pdf.js` | A PDF built with no readable filename was titled **“Images”** in the document metadata | `js.pdf.docTitleFallback` → «صور» |

`tests/i18n.test.js` now scans for text *composed inside a template literal*: `announce(`…`)`,
`parts.push(`…`)`, `progress.set(x, `…`)`, a template assigned to `textContent`/`placeholder`/`title`, a
template passed to `setAttribute('aria-label' | 'title' | 'placeholder' | 'alt', …)`, and a `||` / `??`
fallback containing a space. It follows the rule Gate A established: `core/` and `workers/` are out of
scope because the engines throw English messages that `localizeError()` translates at the UI layer.
The check was written after the five fixes and would have failed on all of them.

### What still needs a native reviewer, beyond the usual

| Item | Count | Note |
|---|---|---|
| «أنت» in guide prose | 10 | The brief said avoid addressing the reader unless it earns its place. Each of the 10 reads naturally in context («أنت تختار الموضع والحجم، لا الشكل»), so they were left rather than sanded down — but this is a style call, not a translation one |
| «تقدم» vs «تقدّم» | 3 vs 3 | The catalogue spells the noun both ways (`تقدم الضغط` next to `تقدّم التحسين`). Only one should survive |
| Brand names left Latin | iPhone, Apple, Windows, Android, Chrome, Edge, Firefox, Safari, Instagram | Deliberate: brand names are not translated. They are the only Latin left in the 14 Arabic guides other than format names, `KB`/`MB`, `A4`/`US Letter` and the `720p`/`1080x1080` numerals |

---

## Deviations from the phase brief

Recorded because the brief specified something different.

| The brief said | What was built | Why |
|---|---|---|
| `src/locales/ar.json` | `content/ar/ui.json`+ `site.json`, `tools.json` | The locale layer already had a shape: `content/<locale>/<file>.json` overlays, resolved by `scripts/lib/content.mjs`, with `loadSite(locale)`, `loadTools(locale)`, `loadPages(locale)` already taking a locale argument. A parallel `src/locales/` directory would have been a second translation mechanism to keep in sync. Master Context rule D |
| `assets/css/rtl.css` | `src/assets/css/rtl.css` | Every other stylesheet lives under `src/assets/css/`, and the build links them as `/assets/css/…`. Nothing else in the project has a top-level `assets/` |
| "test the compare-slider under RTL" | Compare-slider pinned LTR via `direction: ltr` | Deliberately **not** flipped. The slider's `clip-path: inset(…)` is a physically-anchored property and its drag math (`clientX - rect.left`) is physical too, so mirroring the component makes the handle move opposite to the pointer. It is isolated, not flipped — the one place in the layout where RTL does not mirror, and the reasoning is in a comment in `rtl.css` |
| Translate "3–5 highest-priority tools" | Home + 3 tools (Phase 8), then 3 more plus the 6 standalone pages (Gate A) | Confirmed with the project owner before building, twice |
| "the whole site in Arabic" (Gate A brief) | 13 of 28 routes | The brief's own arithmetic counted the 4 Arabic routes that already existed; and its Parts B–E are gated, so the 14 target pages are Gate B's work. The owner confirmed the corrected target of 28 Arabic routes total |

## Maintenance

**Adding an Arabic route** (tool or standalone page):

1. Add the entry to `content/ar/tools.json` or `content/ar/pages.json` — every translatable field, or the
   build fails naming the missing one.
2. A standalone page also needs its own body at `src/templates/ar/pages/<slug>.html`;
   `readLocaleTemplate()` fails the build rather than publishing Arabic chrome over English prose.
3. Add any new UI strings to `content/ar/ui.json` — `tests/i18n.test.js` fails if a key is missing, if a
   value is still English, or if the two catalogues drift out of sync. Take the wording from
   `content/ar/glossary.json`; if a concept is not in the glossary yet, add it there first.
4. Run `npm run gen && npm test`. The sitemap, alternates, language switcher and OG cards pick up the new
   route on their own; nothing is hand-edited.
5. **Open the new page and use it.** A button labelled `js.something.run`, or a status line reading
   `js.common.batchQueued`, is invisible to every check in step 4 — and that is exactly the bug Phase 8
   shipped. `tests/i18n.test.js` now fails on hardcoded literals written into user-visible properties,
   and `verify-gate-a-ar.mjs` scans attributes; both were added because the automated checks missed
   three real defects (`Close menu`, `Waiting`, `Download 4 KB`) that only showed up when the page was
   used.

### The Arabic verification script

`verify-gate-a-ar.mjs` (kept outside the repository, alongside the other scratch verifiers) checks every
`dist/ar/**` page for: `lang="ar" dir="rtl"`, an Arabic canonical, the unreviewed-translation notice,
reciprocal `en`/`ar`/`x-default` alternates **against the English twin**, no Latin prose left in the
visible text beyond the glossary's keep-English list, and no English left in `aria-label`, `title`, `alt`
or `placeholder`. Current result: **13 pages, 10 entirely clean, 3 whose only Latin text is the
`hello@example.com` placeholder** that also appears in English and is still awaiting a real address.
