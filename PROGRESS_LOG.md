# ImageTools — progress log

## Phase 0 — Scaffold + `/compress/` vertical slice

**Status:** code complete, **not compiler-verified**. This machine has no shell
(`run_terminal_command` fails: bash is not installed and `CODEBUFF_GIT_BASH_PATH` is unset),
so `npm install`, `npm run gen`, `npm test` and `vite build` were never executed here. The
`node --test` engine suite and the `npm run gen` idempotency check below are what verify this
work — run them first.

---

## 1. Acceptance checklist

### Locked architecture decisions from the project context

| # | Decision | Status | Notes |
|---|---|---|---|
| 1 | Vite in MPA mode, every page a real HTML file, no SPA/router | **Done** | `appType: 'mpa'`; inputs discovered from disk by `findPageEntries()`; two real pages today (`/`, `/tools/compress/`); no client router anywhere |
| 2 | Every heavy task runs in a Web Worker, never the main thread | **Done** | `/compress/` does decode + resize + encode entirely in `workers/compress.worker.js`; `worker.format: 'es'` |
| 3 | `content/tools.json` and `content/targets.json` are the single sources of truth | **Done** | `tools.json` drives the tool page, homepage grid, header nav, in-page runtime config and sitemap |
| 4 | Declared folder structure | **Done, with 5 flagged additions** | See "Additions beyond the declared structure" below |
| 5 | Approved libraries only | **Done** | Zero new dependencies. `vite ^5.0.0` remains the only one |
| 6 | License red line (no AGPL / NC models; Apache-2.0 or MIT models only) | **Not applicable yet** | No model or image library was added. Two rasteriser candidates for OG images were *identified but not installed* — see open decision #2 |
| 7 | No ads, analytics or third-party tracking scripts | **Done** | No third-party script, font, or remote asset. `favicon.svg` and the OG image are local files |

### Phase 0 deliverables from the approved plan

| Item | Status |
|---|---|
| `src/index.html` exists (the entry `vite.config.js` already pointed at) | Done — unverified by running Vite |
| Content layer: `tools.json`, `targets.json`, `site.json` + validator | Done |
| `build-pages.mjs` / `build-targets.mjs` / `gen-sitemap.mjs` / `gen-og.mjs` | Done, wired to `npm run gen` and `predev`/`prebuild` |
| Homepage grid + primary nav generated from `tools.json` | Done |
| Engine / worker / UI pattern established | Done |
| Worker message contract with ids, progress and cancellation | Done |
| Unsupported-browser path | Done — **changed from the plan**, see deviation 1 |
| `src/index.html` no longer referenced by a missing file | Done |
| Engine unit tests (`node --test`, no deps) | Written — **not run** |
| Sitemap, robots.txt, OG placeholder, favicon | Done |
| Watch-mode regeneration while `vite dev` is running | **Not done — deferred to Phase 1, deliberately** |
| Real 1200x630 PNG social image | **Blocked** — needs a dependency decision (see open decision #2) |
| Canonical production domain | **Blocked on you** — `content/site.json` ships `https://example.com` |
| Any target landing pages | Not applicable — `content/targets.json` is `[]` by design |
| A second tool, WASM encoders, background removal | Out of scope for this phase |

---

## 2. Key decisions made this phase

Asked and answered before implementation:

1. **Site name** — `ImageTools` is canonical and stays hardcoded in the partials.
2. **First vertical slice** — `/compress/`, canvas-native encode with a target-size search.
3. **Generated page location** — committed on disk at `src/tools/<slug>/index.html`, rendered
   from `src/templates/`, matching locked decision #4.
4. **Dependencies** — none beyond `vite`. The worker protocol is hand-rolled.

Decisions made during implementation:

- **Engine is pure and gets its encoder injected.** `searchQuality({ encode })` means the
  engine never touches `createImageBitmap`/`OffscreenCanvas` itself. That is why the same
  file runs in a worker and under `node --test`.
- **Quality search cost is bounded to 2–8 encodes.** Try `maxQuality` first (1 encode when
  no target is set); if it does not fit, try `minQuality` to establish the floor; only then
  binary search between them.
- **An unreachable target is a result, not an error.** The caller still gets the smallest
  file plus `hitTarget: false`, and the UI warns in plain language rather than failing.
- **Default output is WebP; JPEG flattens transparency onto white.** Canvas `image/png`
  output ignores the quality parameter, so PNG-in/PNG-out would not shrink anything.
- **`tools.json` titles are bare** (`"Compress Image Online — Free, Private, No Upload"`);
  the template appends `| ImageTools`, so the brand is never written into content twice.
- **No `<lastmod>` in the sitemap.** A build timestamp would make every run a diff and tell
  crawlers nothing.
- **The workspace contract is a code comment, not a tool.** Progress and cancellation travel
  as `postMessage` messages carrying an `id`; `AbortController` aborts a job between encodes.

---

## 3. Deviations from the approved plan

1. **No main-thread fallback.** The plan said unsupported browsers would fall back to
   main-thread processing reusing the same engine. Locked decision #2 forbids heavy work on
   the main thread, so instead the worker replies `{ type: 'unsupported' }` and the page shows
   a clear notice with the disabled dropzone. Decision #2 outranks the plan detail.
2. **`base.css` edited beyond "a few tokens".** It needed three things to be usable at all:
   a `:root.dark` block (the existing media query could not force dark on a light system, so
   the theme toggle flipped its icon but not the colours), element defaults (there was no
   `box-sizing` reset, no body font/colour) and the missing `.container` (the header and
   footer partials already use it, but it was never defined anywhere).
3. **`layout.css` edited (not in the plan at all).** `.main` had
   `min-height: calc(100vh - var(--header-height))`, which conflicts with
   `body { min-height: 100vh }` and would have produced a scrollbar on every page. Replaced
   with `flex: 1`, which is what makes the sticky footer work.
4. **`robots.txt` is generated, not hand-written.** A `Sitemap:` line must be an absolute URL,
   and the origin lives in `content/site.json`; hand-writing it would duplicate the domain.
5. **`src/partials/theme-boot.html` added.** A tiny inline script applied before first paint,
   in a partial so all three page types share one copy instead of repeating it.
6. **Generated files were authored by hand.** The generators could not be executed here, so
   `src/tools/compress/index.html`, `src/partials/tool-grid.html`, `src/partials/nav-tools.html`,
   `public/sitemap.xml`, `public/robots.txt` and `public/og/default.svg` were written to mirror
   the generator output exactly. **`npm run gen` must be run once to confirm the mirror was
   byte-exact** — an empty `git diff` afterwards is the proof.
7. **FAQ structured data (JSON-LD) not included.** Deriving it from `tools.json` is easy, but
   shipping invalid structured data is worse than shipping none. Deferred to the SEO phase.
8. **The homepage `<head>` is hand-written.** Its canonical and `og:url` are the only place the
   origin is duplicated outside `site.json`, and they carry an HTML comment saying so.
9. **Line endings.** New files use LF; every pre-existing file kept its original CRLF because
   they were changed with targeted edits. Run a normaliser if you want one convention.
10. **`target.template.html` exists before any target does.** `build-targets.mjs` needs a
    template to be meaningful; without it the script would have been a no-op stub.

---

## 4. Open decisions (both need you)

1. **Canonical domain.** `content/site.json` currently says `https://example.com`, so the
   sitemap, canonical tags and `og:url` values are placeholders. Change it there, then also
   fix the two hand-written URLs in `src/index.html`.
2. **OG images.** `gen-og.mjs` writes a 1200x630 **SVG**, not a PNG, and says so loudly on
   every run. Node alone cannot render text into a bitmap, so real PNGs need either:
   - `sharp` (Apache-2.0) — the usual choice, native binary; or
   - `@resvg/resvg-js` (MPL-2.0) — takes an SVG in, gives a PNG out, which pairs naturally
     with the SVG this script already produces; or
   - hand-authored art exported from a design tool, no dependency.

   Neither package is on the approved library list, so nothing was installed. Quote-and-confirm
   as usual. Until then, social previews will show no image.

---

## 5. Files

### Created — content layer (sources of truth)

| File | Purpose |
|---|---|
| `content/site.json` | `name`, `url`, `description`, `ogImage` |
| `content/tools.json` | One entry: `compress` (copy, formats, size limit, FAQ) |
| `content/targets.json` | `[]`; shape defined by the validator |

### Created — build scripts

| File | Purpose |
|---|---|
| `scripts/lib/content.mjs` | Reads and validates the three content files; fails loudly |
| `scripts/lib/render.mjs` | `{{token}}` / `{{{token}}}` engine, `escapeHtml`, generated-file banner, skip-if-unchanged writer |
| `scripts/build-pages.mjs` | Tool pages + `partials/tool-grid.html` + `partials/nav-tools.html` |
| `scripts/build-targets.mjs` | Target pages (writes nothing while `targets.json` is empty) |
| `scripts/gen-sitemap.mjs` | `public/sitemap.xml` + `public/robots.txt` |
| `scripts/gen-og.mjs` | `public/og/default.svg` placeholder + warning |

### Created — templates and partials

| File | Purpose |
|---|---|
| `src/templates/tool.template.html` | Tool page shell |
| `src/templates/target.template.html` | Target page shell |
| `src/partials/theme-boot.html` | Pre-paint theme script (not generated) |
| `src/partials/nav-tools.html` | **Generated** nav items |
| `src/partials/tool-grid.html` | **Generated** homepage grid |

### Created — pages and client code

| File | Purpose |
|---|---|
| `src/index.html` | Homepage: hero + generated grid |
| `src/tools/compress/index.html` | **Generated** tool page |
| `src/assets/js/core/engine-compress.js` | Pure logic: `fitWithin`, `searchQuality`, `estimateSavings`, parsers |
| `src/assets/js/workers/compress.worker.js` | Owns `createImageBitmap` / `OffscreenCanvas` / `convertToBlob`; message protocol |
| `src/assets/js/tools/compress.js` | Hints-free wiring: dropzone → worker → progress → download |
| `src/assets/js/ui/site.js` | Theme toggle, mobile menu, footer year |
| `src/assets/js/ui/dropzone.js` | Drag/drop/paste/keyboard dropzone + `formatBytes` |
| `src/assets/js/ui/progress.js` | Progress bar with `aria-valuenow` |
| `src/assets/css/components.css` | Component styles built only from existing tokens |
| `tests/engine-compress.test.js` | 20 engine tests, `node --test`, no dependencies |
| `public/sitemap.xml`, `public/robots.txt`, `public/og/default.svg` | **Generated** |
| `public/favicon.svg` | Hand-written |

### Modified

| File | Change |
|---|---|
| `package.json` | Added `gen*`, `predev`, `prebuild`, `test` scripts. No dependency changes |
| `vite.config.js` | Disk-discovered MPA inputs, `appType: 'mpa'`, `worker.format: 'es'`, single `inlinePartials()` helper (removed the duplicated include logic), cwd-independent paths |
| `src/partials/header.html` | Skip link; nav stubs replaced with the generated nav include (`About` left as `#` because that page does not exist yet) |
| `src/assets/css/base.css` | Explicit `:root.dark` tokens, element defaults, `.container` |
| `src/assets/css/layout.css` | `.main` uses `flex: 1` instead of the conflicting viewport calc |

---

## 6. Content schemas

`content/site.json` — object:

| Key | Required | Notes |
|---|---|---|
| `name` | yes | Brand, used in titles and meta |
| `url` | yes | Absolute origin, no trailing slash; validated |
| `description` | yes | Default meta description |
| `ogImage` | yes | Root-relative path, e.g. `/og/default.svg` |

`content/tools.json` — array of objects:

| Key | Required | Notes |
|---|---|---|
| `slug` | yes | Kebab-case; becomes `/tools/<slug>/` and `assets/js/tools/<slug>.js` |
| `name`, `navLabel` | yes | Card title / nav text |
| `status` | yes | `live` or `planned`; only `live` produces a page, grid link and sitemap entry |
| `category` | yes | Free-form; not yet used for grouping |
| `title` | yes | **Bare** title; the template appends `\| ImageTools` |
| `description`, `h1`, `intro` | yes | Meta description, page h1, intro paragraph |
| `keywords` | yes | Array of strings |
| `accepts` | yes | Input mime types |
| `outputs` | yes | Output mime types, non-empty |
| `defaultOutput` | yes | Must be one of `outputs` |
| `maxInputBytes` | yes | Positive integer; rendered into the dropzone hint |
| `related` | yes | Array of existing slugs (self-reference rejected) |
| `faq` | no | `[{ q, a }]`, rendered as `<details>` |
| `ogImage` | no | Overrides `site.ogImage` |

`content/targets.json` — array of objects: `slug`, `parentTool` (must exist in `tools.json`),
`status`, `title`, `description`, `h1`, `intro`, `keywords`.

The validator rejects unknown-shaped data with the exact file and key, so a typo fails the
build instead of producing a blank `<title>`.

---

## 7. Worker contract (the pattern later tools copy)

```
-> { id, type: 'compress', payload: { blob, outputMime, targetBytes, maxWidth, maxHeight } }
<- { id, type: 'progress', phase: 'decode'|'fit'|'search'|'encode', ratio, quality?, attempt? }
<- { id, type: 'done', blob, meta: { …bytes, quality, hitTarget, scaled, dimensions… } }
<- { id, type: 'error', code, message }
<- { id, type: 'unsupported', missing: [...] }
-> { id, type: 'cancel' }
```

Every reply echoes `id`, so concurrent jobs cannot cross-talk. Cancellation is cooperative via
`AbortController`, checked between encodes. `meta.hitTarget === false` means the target size was
unreachable and the delivered file is the smallest achievable.

---

## 8. Manual test procedure

Run from the project root. Nothing here has been executed yet.

1. `npm install`
2. `npm run gen`
   Expect: `build-pages: wrote 3 files`, `build-targets: up to date`, `gen-sitemap: wrote 2 files`,
   `gen-og: wrote 1 file`, plus the OG placeholder warning.
3. `npm run gen` **again**, then `git status --short`
   Expect: **no modifications** for `src/tools/compress/index.html`, `src/partials/tool-grid.html`,
   `src/partials/nav-tools.html`, `public/sitemap.xml`, `public/robots.txt`, `public/og/default.svg`.
   Any diff here means the hand-authored mirrors in deviation 6 are wrong — the generator wins;
   re-run and commit its output.
4. `npm test`
   Expect: 20 passing tests (the engine suite).
5. `npm run dev` → open `/`
   - Hero renders, one tool card ("Compress Image") in the grid, header nav shows "Compress".
   - Toggle the theme: colours change **and** the icon swaps; reload keeps the choice.
   - Narrow the window below 768px: the hamburger opens a dropdown; Escape closes it.
   - Footer year is the current year.
6. Go to `/tools/compress/`
   - Drop a JPEG. Progress runs, then a before/after preview, size, dimensions and quality appear.
   - `Download` gives a smaller file with a `-compressed` suffix.
   - Set "Target file size (KB)" to something small (e.g. `20`) and re-drop: either it fits, or
     you get the warning that the target was unreachable — never a silent failure.
   - Set max width to `400`: dimensions shrink and the file gets smaller.
   - Switch output to JPEG with a PNG that has transparency: the result should be flattened onto
     white, not black.
   - Press Cancel mid-run: the job stops and the UI re-enables.
   - Paste an image from the clipboard into the page: it is accepted.
7. **Privacy check:** DevTools → Network, clear, then compress. Expect requests to local assets
   only — no upload, no third-party host. Confirm the "100% client-side" claim yourself.
8. **Worker check:** DevTools → Sources → Threads: a worker thread should appear during a run.
   Drop a deliberately large image (20MP+) and confirm the page never freezes — that is the
   point of decision #2.
9. `npm run build` → expect `dist/index.html`, `dist/tools/compress/index.html`,
   `dist/sitemap.xml`, `dist/robots.txt`, `dist/og/default.svg`, `dist/favicon.svg`.
   Then `npx vite preview` and repeat step 6 against the built output.

---

## 9. What Phase 1 may assume

- `npm run gen` runs automatically before `dev` and `build`; generated files are committed.
- A new tool page needs **only** a new `content/tools.json` entry plus
  `src/assets/js/tools/<slug>.js` (and a worker + engine if it processes anything). No page HTML,
  no nav edit, no sitemap edit.
- `content/targets.json` is the only thing needed to create long-tail landing pages.
- The pattern to copy: pure `core/engine-*.js` with injected browser capabilities →
  `workers/<name>.worker.js` owning the browser APIs → `ui/<component>.js` → `tools/<slug>.js`
  wiring. One worker per tool, `{ id }`-tagged messages, progress + cancel supported.
- Every tool page gets `#tool-config` (from `tools.json`) and `/assets/js/ui/site.js` for free.
- **Not** yet available: live regeneration during `vite dev`, JSON-LD, a raster OG image, a
  deployed origin, or any WASM-based encoder.
- `node --test tests/` is the only test harness; no test framework has been added.

---

## Phase 0 (design system + dropzone) — additive pass

This phase prompt asked for a design-system foundation and forbade tool logic, `content/tools.json`
and anything under `src/tools/`. Those already existed from the approved plan and the file tools
needed to remove them were unavailable on this host, so we agreed to proceed **additively**: fill the
Phase 0 gaps on top of the existing work and inventory the extras here rather than deleting them.

### Done in this pass

| Item | Where |
|---|---|
| Dropzone reduced to a pure emit-only component | `src/assets/js/ui/dropzone.js` |
| Homepage dropzone test instance + visible log | `src/index.html`, `src/assets/js/home-demo.js` |
| Dropzone visual states `is-invalid` / `has-file` | `src/assets/css/components.css` |
| Range slider + compare-slider visual states | `src/assets/css/components.css` |
| Playground styles for the temporary homepage section | `src/assets/css/components.css` |

### Dropzone contract (changed this pass)

```js
createDropzone(root, { accept = null, maxBytes = null, multiple = false, onFiles, onReject })
```

- **Validation is opt-in.** With `accept` and `maxBytes` both null the component forwards whatever the
  browser gives it, empty files included, because deciding what is acceptable is the caller's job.
  That is what satisfies "no processing logic inside it".
- **`onFiles(files)` replaced `onFile(file)`** and always receives an array, since drag-and-drop and
  paste routinely carry several files. With `multiple: false` the list is truncated to the first and
  the extras are reported as `TOO_MANY_FILES` rather than silently dropped.
- Rejection codes: `EMPTY_FILE | TOO_LARGE | UNSUPPORTED_TYPE | TOO_MANY_FILES`.
- Three input paths, one handler: a native `<label>` + `<input type="file">` (works before JS loads),
  drag and drop, and document-level paste.
- Visual states on the root element: `is-dragging`, `is-disabled`, `is-invalid` (transient, 2.4 s),
  `has-file`. API: `destroy()`, `disable()`, `enable()`, `reset()`, `open()`.

`src/assets/js/tools/compress.js` was updated for the rename (`onFiles: (files) => selectFile(files[0])`)
and now calls `dropzone.reset()` in `startOver()`. Its own behaviour is unchanged: it still passes
`accept` and `maxBytes` explicitly, so the tool keeps validating.

### Deviations from this phase's wording

1. **Ahead-of-scope files were kept, not deleted** — see the inventory below.
2. **The homepage keeps the generated tools grid**, and the header nav keeps its real links, because
   "no tool grid yet" / "no real links yet" conflict with keeping the approved plan's work. Visible in
   `src/index.html` and `src/partials/nav-tools.html`.
3. **`vite.config.js` was not changed.** It was already MPA mode; its disk-based input discovery yields
   exactly one entry while `src/tools/` is the only subdirectory, and it retains the partials plugin
   this phase asks for.
4. **`base.css` / `layout.css` were not changed.** They already provide the colour, spacing and
   typography variables, the `prefers-color-scheme` block, an explicit `:root.dark` block, element
   defaults and `.container`.
5. **"Slider" was ambiguous**, so both readings are implemented as CSS: a styled
   `input[type="range"]` (`.slider`) and a before/after `.compare-slider`. Only `dropzone.js` is named
   as a JS component this phase, so neither has behaviour yet.
6. **`home-demo.js` is a file beyond the phase's list**: the homepage instance needs wiring, and an
   inline `<script type="module">` would break in `dist/` because Vite does not rewrite inline module
   imports. It is throwaway — delete it along with the `.playground` markup and styles.
7. **The card component is the existing `.tool-card`.** A second generic `.card` would be duplication.

### Ahead-of-scope inventory

Files in the tree that this phase's "Do NOT" list forbids. Delete them to match this phase literally;
they are the approved plan's work and are unverified (nothing here has ever been run).

- `content/tools.json`, `content/targets.json`, `content/site.json`
- `scripts/build-pages.mjs`, `scripts/build-targets.mjs`, `scripts/gen-sitemap.mjs`, `scripts/gen-og.mjs`,
  `scripts/lib/content.mjs`, `scripts/lib/render.mjs`
- `src/tools/compress/index.html`
- `src/assets/js/core/engine-compress.js` (compression logic)
- `src/assets/js/workers/compress.worker.js` (compression logic)
- `src/assets/js/tools/compress.js` (compression logic)
- `src/templates/tool.template.html`, `src/templates/target.template.html`
- `src/partials/tool-grid.html`, `src/partials/nav-tools.html` (generated)
- `src/assets/js/ui/progress.js` (used by the compress tool)
- `public/sitemap.xml`, `public/robots.txt`, `public/og/default.svg` (generated)
- `tests/engine-compress.test.js`

`src/assets/js/ui/site.js` and `src/partials/theme-boot.html` are **kept deliberately**: the theme
toggle and the pre-paint script are this phase's criterion 3. `package.json` (gen/test scripts),
`vite.config.js`, `src/partials/header.html`, `base.css` and `layout.css` also carry the plan's edits;
reverting them would break the kept files.

### Acceptance checklist for this phase

| # | Criterion | Status |
|---|---|---|
| 1 | `npm run dev` runs with no errors | **Blocked** — no shell on this host; must be run by hand |
| 2 | Dropzone accepts drag/drop, paste and click, and logs the files | Implemented; `console.log` plus an `aria-live` log line. Verification blocked on 1 |
| 3 | Dark mode toggles via CSS variables with no unstyled flash | Done — `base.css` tokens + `:root.dark`, and `partials/theme-boot.html` applies the class in `<head>` before first paint |
| 4 | No console errors or warnings | By design: the demo path never calls `warn`/`error`. Verification blocked on 1 |
| 5 | `PROGRESS_LOG.md` created with today's decisions | Done — this section |

---

## Phase 1 — Compression engine + first complete tool

Phase 1 assumed a greenfield engine and a hand-written tool page. Neither was true: the tree already
had a pure Canvas engine with 19 passing tests, a hand-rolled worker protocol, and a page generated
from `content/tools.json`. Three questions settled it, and the answers were all the recommended
option (see "Decisions" below). The engine's architecture is unchanged in shape — pure logic with
browser capabilities injected — but the encoder is now the approved library, the search has moved to
its own module, and the transport is comlink.

### Decisions

1. **Slug renamed `compress` → `compress-image`.** The page is now `/tools/compress-image/`, its
   script `/assets/js/tools/compress-image.js`. This is a content-layer change (one field) that the
   generator propagates to the page, the nav, the homepage grid and the sitemap.
2. **The page stays generated** from `content/tools.json` + `src/templates/tool.template.html`, so
   the phase's "hardcode the copy" instruction is satisfied without duplicating metadata in two
   places. New markup went into the shared template; per-tool bodies become necessary when a second
   tool ships.
3. **browser-image-compression is the encode step, injected by the worker into the pure engine.**
   This keeps the Phase 0 seam (and the ability to test the engine in plain Node) while following the
   phase's instruction to wrap the library. `core/target-size.js` owns the search.

### What shipped

| Piece | Where |
|---|---|
| Target-size search with `hit` / `near` / `unreachable` outcomes | `core/target-size.js` (new) |
| Shared `CompressError`, so target-size and the engine do not import each other | `core/errors.js` (new) |
| `libraryOptions()` + `compressFile()` on top of the library | `core/engine-compress.js` |
| Worker rewritten on comlink, one worker per page, real `AbortSignal` cancellation | `workers/compress.worker.js` |
| Batch runner with bounded concurrency, per-item progress, cancel and retry | `core/queue.js` (new) |
| Single download + ZIP (fflate, stored level) | `core/file-io.js` (new) |
| Before/after slider driving the Phase 0 CSS contract + savings readout | `ui/compare-slider.js` (new) |
| `formatBytes` / `formatSignedPercent` in one place | `ui/format.js` (new) |
| Batch rows, compare-slider input and readout styles | `css/components.css` |
| Multi-file input, batch list, compare slider, revised notes copy | `templates/tool.template.html` |
| The wiring: dropzone → queue → worker → slider → ZIP | `tools/compress-image.js` (new) |
| Copy, keywords, two new FAQ entries, new slug | `content/tools.json` |
| `browser-image-compression`, `comlink`, `fflate` | `package.json` |

**Renamed:** `src/tools/compress/` → `src/tools/compress-image/`. **Deleted:** the old
`src/assets/js/tools/compress.js`. Note there is **no git repository in this workspace**, so that
deletion has no version-control backup behind it.

### How the engine talks to the library

`libraryOptions()` maps our options onto the library's, and three keys are load-bearing:

- `useWebWorker: false` is **mandatory**, not a preference. The library defaults to `true` and, in
  that mode, imports itself into its own worker from its `libURL` default — a jsdelivr CDN URL. That
  would be a third-party request from every visitor's browser on a site whose entire pitch is that
  nothing leaves the device. We are already inside a worker, so the library has nothing to add.
- `maxIteration: 1`, so one call means exactly one encode at exactly one quality. Without it the
  library runs its own quality loop and the binary search stops being a search.
- `maxWidthOrHeight` only when `fitWithin()` decided to scale, passed as the fitted longest side.
  That reproduces a two-constraint box (which the library cannot express) while preserving the
  ratio, and omitting it means the encoder has no value to enlarge with.

`alwaysKeepResolution` is deliberately **left at its default**, which is a change from the approved
plan (the plan said to set it to `true`). Setting it disables the library's clamp to the browser's
maximum canvas size — the one memory guard mobile Safari leans on — and it is not clear that it
leaves our own `maxWidthOrHeight` request intact. The risk we accepted instead is that a very large
image may be clamped below the requested dimensions on a browser with a small canvas limit, which
would make the reported dimensions optimistic. That is a diagnostic wart, not a broken result; the
other choice could silently ignore a resize the user asked for.

### Verification actually performed

Node is not installed on this machine and `node_modules` does not exist, so `npm install`,
`npm test`, `npm run gen` and `npm run dev` are all still yours to run. What I could do instead:
this machine has a **Bun 1.4.2 runtime bundled with the Freebuff desktop app**, which is a real JS
engine, so the pure-logic layer is genuinely verified rather than eyeballed.

| Check | Command | Result |
|---|---|---|
| Bounded search, queue, engine tests | `bun test tests/target-size.test.js tests/engine-compress.test.js tests/queue.test.js` | **60 passed, 0 failed** |
| File naming + ZIP entry logic | `bun test tests/file-io.test.js` | 7 passed; the one failure is `fflate` not being installed (verified with a throwaway stub that was then deleted) |
| Syntax/transpile of every JS file | `bun build --no-bundle <file>` for all 24 JS/MJS files | 0 failures |
| Savings readout (criterion 3) | `bun -e` against `ui/compare-slider.js` | `2.4 MB → 94 KB (-96.2%)`, growth renders as `(+100%)`, junk input renders as empty |
| Generator idempotency after the rename | `bun scripts/build-pages.mjs`, `build-targets`, `gen-sitemap`, `gen-og` | All four report **up to date** — the hand-mirrored page, nav, grid and sitemap are byte-exact with the generator's output |

Those last two together mean the rename and the new template are consistent end to end, and the
"run `npm run gen` twice, expect no diff" invariant holds by construction rather than by hope.

**Still unverified, because it needs a real browser:** every DOM path (dropzone wiring, row
rendering, slider dragging), every path through `browser-image-compression`, and the ZIP download.

### Deviations from this phase's wording

1. **`compressFile()` returns `{ blob, meta }`, not a bare Blob.** The UI needs dimensions, quality
   and the target outcome; recovering those from a Blob alone would mean decoding the output twice.
2. **Comlink replaced Phase 0's `{ id }`-tagged message protocol** (the phase asked for comlink).
   The old routing is gone; the worker's job map survives only as the abort registry.
3. **Tolerance is reporting-only.** `searchTargetBytes()` never returns a file above the target as a
   `hit`; a target missed by under 2% comes back as `near` with the shortfall, and anything further
   out is `unreachable`. Nothing overshoots silently.
4. **One image auto-runs on drop; a batch waits for the button.** Criterion 1's flow stays
   click-free, but a settings tweak cannot silently restart fifty jobs.
5. **`core/errors.js` is a file the approved plan did not list.** Without it, `target-size.js` and
   `engine-compress.js` would import each other in a cycle.
6. **The batch list shows one row per file, including a single file.** A one-file row also carries
   the Retry button, and the header buttons stay hidden when there is only one file.
7. **Phase 0's log sections keep their old `/tools/compress/` paths.** They are a record of what was
true then; the URLs are now `/tools/compress-image/`.

### Acceptance checklist

| # | Criterion | Status |
|---|---|---|
| 1 | "100" KB produces a file at or under 100 KB, or the smallest achievable with a clear message | **Implemented and unit-verified.** The never-exceed guarantee is tested across a spread of targets; the `near` / `unreachable` copy is in place. The end-to-end download needs a browser |
| 2 | 5+ images without freezing the UI, per-file progress, single ZIP | **Implemented.** Concurrency is capped at 2 (tested), progress is per item and aggregate, cancel and retry are tested; the ZIP needs `npm install` before it can run |
| 3 | Before/after slider and savings readout work | **Readout verified** (`2.4 MB → 94 KB (-96.2%)`). Dragging and keyboard need a browser |
| 4 | Tested on latest Chrome, Firefox and Safari | **Not done — no browser on this host.** Procedure below |

### Manual test procedure

1. `npm install` → `npm run test` (expect 4 files, no failures) → `npm run gen` (expect nothing
   changed) → `npm run dev`.
2. `/` and `/tools/compress-image/` both load, console clean. `/tools/compress/` now 404s in dev —
   expected, it is an MPA and the page moved.
3. **Criterion 1:** drop a ~4 MB JPEG, type `100` in Target file size, tab out. The row and the
   result panel report the output; check the downloaded file in Explorer is ≤ 100 KB. Then try `5`
   to see the "cannot reach" warning, and clear the field for best quality.
4. **Criterion 2:** drop 6 images. The rows appear as "Waiting" — press **Compress all**. Per-file
   bars advance two at a time, the page stays scrollable and the theme toggle still works mid-run.
   Then **Download all as ZIP** and unzip: six files, correctly named, no collisions.
5. **Criterion 3:** drag the divider with the mouse, then Tab to it and use the arrow keys. The
   readout should match Explorer's byte sizes. Try an already-optimised PNG to see a `(+N%)` case.
6. **Criterion 4:** Chrome and Firefox. Safari: confirm it either compresses correctly or shows the
   "cannot run the compressor" notice — never a frozen page. In DevTools → Network, confirm **no
   request to jsdelivr or any other origin** while compressing; that is the `useWebWorker: false`
   proof.
7. Cancel mid-run and confirm the rows show cancelled rather than sticking; press Retry on one.

### Known risks carried into Phase 2

- **Does the library actually run inside our worker on Safari?** It needs `OffscreenCanvas`; the
  capability probe gates on it and the fallback is the notice, but the happy path is unproven. This
  is the single riskiest assumption in the phase.
- **Transparency → JPEG.** The result panel claims transparent areas are flattened onto white. That
  is the expected behaviour of the library's JPEG path, but it is unverified; if it turns out the
  library leaves alpha to the encoder, the copy is wrong and needs fixing.
- **A target search re-decodes the source once per iteration** (up to ~8 encodes). Phase 0 decoded
  once and reused one canvas. If it feels slow, the fix is to pre-resize once to a lossless
  intermediate and search on that.
- **`npm run gen` has never run under Node here** — only under Bun, which is not the project's
  runtime. The scripts use `node:fs`/`node:path`/`node:url` only, so the risk is low, not zero.
- **Dependency versions in `package.json` are best-effort** and were not checked against the
  registry (no npm here).

### What Phase 2 should assume exists

- `npm run test` runs `node --test tests/` over four files, all dependency-free fakes.
- The pattern to copy for later tools: `core/<logic>.js` (pure, injected browser capabilities) +
  `core/queue.js` + `core/file-io.js` + `ui/` components + one comlink worker + `tools/<slug>.js`.
- `tools/compress-image.js` is the reference wiring: batch rows, per-item progress, cancel, retry,
  ZIP, and a compare slider bound to one selected result.
- `src/templates/tool.template.html` is still a **single shared template** for every tool page, and
  it now carries compress-specific batch and compare-slider markup. A second tool needs per-tool
  bodies (`src/templates/tools/<slug>.html`) or a careful split of that template.
- The generators are idempotent, `writeGenerated` skips unchanged files, and every generated file
  carries a "do not edit by hand" banner.

### Open decisions (unchanged from Phase 0)

1. **Canonical origin** — `content/site.json` still ships `https://example.com`, so the canonical
   tags, `og:url` and the sitemap are all placeholders.
2. **Real OG images** — `gen-og.mjs` still emits an SVG that most social platforms ignore. Real
   1200×630 PNGs need a rasterizer (`sharp`, Apache-2.0, or `@resvg/resvg-js`, MPL-2.0), neither of
   which is on the approved list, so nothing was installed.

---

## Phase 2 — Content factory (tools.json) + trust pages

This phase described the generator as something to build. It already existed from the approved
Phase 0 plan, so the work became widening it: a schema with stable ids, planned tools that produce
real pages, standalone pages as a first-class content type, and an audit that refuses to let a guessed
fact ship quietly.

### Decisions

1. **Trust pages publish at `/pages/<slug>/`** — `src/pages/<slug>/index.html`, matching the path in
the phase prompt and the repo's existing "one directory, one page" shape.
2. **The schema grows additively.** `id` is new and stable; `slug` is the URL and may change. `related`
   now references **ids**, which is the direct fix for the `compress` → `compress-image` rename that
   broke the old slug-based references. `targetKeyword` is added alongside the existing `keywords`
   array rather than replacing it.
3. **Planned tools produce pages again**, template-selected by status, `noindex,follow`, and excluded
   from the sitemap until they go live.
4. **No legal entity is named**; the pages say the site is run by its maintainer.
5. **Contact is one email address**, held in `content/site.json` so it exists in exactly one place.
6. **Governing law is a visible placeholder**, and the privacy page states only what the code does.

### What shipped

| Piece | Where |
|---|---|
| `id` + `targetKeyword` per tool, `related` by id | `content/tools.json` |
| Four planned tools with full metadata (resize, convert, crop, image-to-pdf) | `content/tools.json` |
| Standalone page routes | `content/pages.json` (new) |
| Contact email + optional repo URL | `content/site.json` |
| Pure validators (`validateTools`/`validatePages`/`validateSite`) + `loadPages`, `pagePath` | `scripts/lib/content.mjs` |
| `findPlaceholders` / `reportPlaceholders` | `scripts/lib/render.mjs` |
| Template selection by status, standalone pages, both navs, placeholder audit | `scripts/build-pages.mjs` |
| Static page routes in the sitemap | `scripts/gen-sitemap.mjs` |
| Shared standalone-page layout | `src/templates/page.template.html` (new) |
| Coming-soon tool page layout | `src/templates/tool-planned.template.html` (new) |
| The five prose bodies | `src/templates/pages/{about,how-it-works,privacy,terms,contact}.html` (new) |
| Generated footer nav | `src/partials/nav-pages.html` (new), included by `src/partials/footer.html` |
| Generated header nav (`nav` field in `pages.json`) | `src/partials/nav-header-pages.html` (new), included by `src/partials/header.html` |
| Nested partial includes | `vite.config.js` |
| `.prose`, `.page-meta`, `.page-placeholder`, `.planned-tools`, planned-card padding | `src/assets/css/components.css` |
| 10 validator/audit tests | `tests/content.test.js` (new) |

Generated output today: 11 pages (homepage, 5 tool pages, 5 standalone pages), 3 partials, sitemap
with 7 routes. `package.json` needed no change — `predev`/`prebuild` already run the whole `gen`
chain, and `gen` already chains build-pages → build-targets → gen-sitemap → gen-og.

### The two interesting mechanisms

**Nested partial includes.** `inlinePartials` made a single pass, so a partial containing an include
would have leaked a raw `<!--#include ...-->` comment into the page. `vite.config.js` now expands
repeatedly until the document stops changing, with a depth guard so a self-including partial is a
no-op instead of a hang. That is what lets the footer contain the generated page nav.

**The placeholder audit.** `findPlaceholders()` scans every rendered page for explicit `TO CONFIRM`
markers and for `example.com`-style addresses and URLs, and `build-pages` prints them grouped by value
with the pages affected. It is deliberately report-only rather than a build failure — the content is
not final yet — but nothing invented can ship without appearing on every run. It currently reports
three values: the canonical origin, the contact address, and the two `TO CONFIRM` markers. That
first one is welcome: the Phase 0 decision about the domain is now surfaced automatically instead of
living only in this log.

### Verification actually performed

Same constraint as Phase 1 — no Node here — so the bundled Bun 1.4.2 runtime did the work again.

| Check | Result |
|---|---|
| `bun test tests/` | **70 passed**; the one failure is `tests/file-io.test.js` failing to load `fflate`, which `npm install` fixes |
| `bun test tests/content.test.js` | 10 passed (schema failures, id/slug uniqueness, related ids, page validation, placeholder audit, `render()` fail-loud) |
| All four generators, twice | Second run reports **up to date** for every file — idempotency holds |
| **Criterion 1, end to end** | Added a sixth tool object, ran the generators: a page appeared at `/tools/gen-test/` using the **live** template (1 config block, dropzone, engine script, no `noindex`), linked from `nav-tools.html` and `tool-grid.html`, and present in the sitemap (8 routes). Then removed it, deleted the orphan page and re-ran: back to 5 tools, 7 routes, generators up to date |
| **Criterion 2** | All **33 runtime hooks** the compress tool depends on are still on the regenerated page (`data-compare-*`, `data-file-list`, `data-progress-region`, `#tool-config`, engine script, `multiple`), the `#tool-config` JSON block is byte-identical to Phase 1's, and the top-level `noindex` is absent. No runtime JS was touched this phase |
| **Criterion 3** | 11 generated pages on disk vs 7 sitemap routes: the only generated-but-unlisted pages are exactly the four **planned** tool pages, and nothing is listed that doesn't exist |
| Nested includes | Expanded the real files with the plugin's algorithm: **0 leftover include comments** on the homepage, a standalone page, a planned tool page and the live tool page; the footer renders 5 links (About, How it works, Privacy, Terms, Contact) |
| Planned vs live treatment | Planned page: 1 `noindex`, 0 config blocks, 0 engine-script references, not in the sitemap. Live page: the inverse |

### Acceptance checklist

| # | Criterion | Status |
|---|---|---|
| 1 | Adding an object to tools.json and re-running the build creates a correctly linked page with no hand-edited HTML | **Proven** — done live with a temporary sixth tool, including nav, grid and sitemap |
| 2 | compress-image still works exactly as in Phase 1 | **Verified as far as static checks can go**: byte-identical config block, all 33 hooks intact, runtime JS untouched, test suite green. Browser behaviour still needs your `npm run dev` |
| 3 | sitemap.xml lists every generated page | **Verified**, with the four planned pages deliberately excluded and `noindex` — see the table above |
| 4 | Trust pages read as genuine, specific text; every guessed field flagged | Written from verified facts (see below); four unconfirmed fields are flagged loudly rather than invented |

### Why the trust copy can be specific

I checked the shipped code rather than describing it: there is **no `fetch`, no `XMLHttpRequest`, no
`document.cookie` and no `sessionStorage` anywhere**, the only client storage is
`localStorage['imagetools:theme']` written solely by the theme toggle, fonts are system stacks, and no
third-party asset is loaded. That makes "your image cannot be uploaded — there is no upload code" a
checkable statement, and it is exactly what the privacy page says. The pages also say plainly that a
static host necessarily sees IP addresses and request paths, which is the one place a visitor's data
genuinely exists.

### TO CONFIRM — flagged, not invented

Visible in the generated HTML, listed by every `build-pages` run, and versioned here:

1. **Contact email** — `hello@example.com` in `content/site.json`, rendered on the contact page and in
the privacy policy. One content edit changes both.
2. **Repository URL** — `contactRepo: null`, so the contact page shows a `TO CONFIRM` marker instead
of a link. The footer's old dead `href="#"` GitHub link was removed rather than left dangling.
3. **Governing-law jurisdiction** — a visible `TO CONFIRM` block in the terms, replacing the usual
clause. Nothing is asserted about which law applies.
4. **Hosting provider name** — the privacy page describes static-host access logging generically. If
you pick a host, naming it is a one-sentence upgrade; a `TO CONFIRM` marker would read badly here, so
this one is prose plus this note rather than a visible placeholder.
5. **Canonical origin** — still `https://example.com` (Phase 0 open decision), now surfaced by the
audit on all ten pages.
6. **The four planned tools' engine-shaped fields** — `maxInputBytes`, `accepts`, `outputs` and the
keyword lists are metadata placeholders that Phase 3 will have to reconcile with the real engines.
`image-to-pdf` outputs `application/pdf`, so the generator's mime map gained a `pdf` extension.

### Deviations from this phase's wording

1. **`content/pages.json` is a new content file.** The sitemap philosophy in `gen-sitemap.mjs` is
explicit that routes come from content rather than from disk, so the standalone pages needed a content
home; hard-coding the list in the generator would have been the alternative.
2. **The trust pages are generated, not hand-written files.** One page template means the head,
canonical, OG tags, breadcrumb and footer cannot drift across five pages, and the footer nav derives
from the same route list. The prose itself lives in five hand-written bodies.
3. **`vite.config.js` is touched** to support nested partial includes.
4. **`related` changed meaning** from slugs to ids — a deliberate change to a field Phase 1 used.
5. **"FAQ schema-ready markup" is read as** semantic `<details>/<summary>` with `data-faq` hooks and
**no** JSON-LD, since deep Schema.org markup is explicitly a later phase. Worth revisiting then:
answers hidden inside `<details>` are not eligible for FAQ rich results as they stand.
6. **Planned-tool pages are `noindex,follow`** and excluded from the sitemap, but they *are* linked from
the homepage grid and the nav — thin pages shouldn't be indexed, though the link helps the page get
found once it works.
7. **Partials are still inlined by the Vite plugin**, not by `build-pages.mjs`, even though this phase
says the script reads `src/partials/*`. That split is deliberate: it is what guarantees `vite dev` and
`vite build` render identical HTML.8. **The placeholder audit reports the canonical origin on all ten pages.** Grouped by value rather
   than by page so the signal isn't buried, but it is still the same finding repeated as the page count
   grows; if it gets noisy, the origin should be audited once at the site level.
9. **A header fix this phase did not ask for.** `src/partials/header.html` carried a hardcoded
   `<a href="#" class="nav-link">About</a>` — a dead link left from the original scaffold, which this
   phase's new About page supersedes. Hand-coding `/pages/about/` into the header would have put the
   label and the route in two places, so the header now includes a generated partial and `pages.json`
   gained an optional `nav` field (`["header"]`, `["footer"]` or both) declaring where a page is linked
   from. Rendered header nav is now: Compress | Resize | Convert | Crop | Image to PDF | About, with the
   four planned tools as non-link text. No `href="#"` remains anywhere under `src/`.

### Still to verify by hand

- `npm install`, then `npm run dev`: `/pages/about/`, `/pages/privacy/` and `/tools/resize-image/`
  should all load. The dev-server middleware only intercepts URLs ending in `.html`, so directory-style
  URLs like `/pages/about/` rely on Vite's own index resolution — worth confirming in dev as well as in
  `npm run build` output.
- Whether the trust pages read well is a judgement call, not something a compiler can settle.

### What Phase 3 should assume exists

- `content/tools.json` with stable `id`s, a `slug` that may change, `targetKeyword`, and `related` by id.
- Two tool page templates, chosen by `status`; adding an engine means adding a `tools/<slug>.js` file,
  flipping `status` to `live`, and deleting nothing.
- `content/pages.json` + `src/templates/pages/<slug>.html` for standalone prose, with the footer nav
  and sitemap derived from it.
- A placeholder audit that runs on every `npm run gen` and prints what still needs a human.
- `tests/content.test.js` proving the validators fail loudly, so a malformed new tool entry is caught by
  `npm test` rather than by a broken page.

---

## Constitution compliance audit + four rulings (post-Phase 2)

A full re-read of the locked architecture decisions against the actual tree, plus the four judgement calls
it raised. Two of the four produced code changes; two are rulings recorded here for later phases.

### The seven locked decisions, verified

| # | Decision | Evidence | Status |
|---|---|---|---|
| 1 | Vite MPA, every page a real indexable file | 11 `index.html` files discovered from disk by `findPageEntries()`; no router anywhere | ✅ |
| 2 | Heavy work in a Web Worker | compress/decode/resize/quality search run under comlink in `compress.worker.js`, capability-gated on `OffscreenCanvas` | ✅ with one caveat (ruling 4) |
| 3 | `tools.json` + `targets.json` as single sources of truth | they drive the pages, the homepage, the navs, the sitemap and each page's runtime config | ⚠️ one exception, now closed (ruling 2) |
| 4 | Declared folder structure | every declared path exists and is respected | ⚠️ five additions, listed below |
| 5 | Approved libraries only | exactly four imports project-wide: `vite`, `browser-image-compression`, `comlink`, `fflate` | ✅ |
| 6 | License red line | no model, weights or third-party asset has been integrated at all yet | ✅ nothing to review |
| 7 | No ads/analytics/tracking | `https://` appears in shipped source only as the `example.com` placeholders; no `fetch`, XHR, cookie or analytics call | ✅ |

**Structure additions beyond decision 4** (all blessed in this pass): `content/pages.json`, `src/pages/`,
`src/templates/` plus `src/templates/pages/`, `scripts/lib/`, `tests/`, and the five generated partials
(`tool-grid`, `nav-tools`, `nav-pages`, `nav-header-pages`, `theme-boot`). `core/` also holds
`target-size.js`, `queue.js`, `file-io.js` and `errors.js` beside `engine-<name>.js` — shared plumbing
rather than engines.

### Ruling 1 — `content/pages.json` is a third content file

Recorded, no code change. Phase 2 asked for `src/pages/*` without saying where those routes live, and
`gen-sitemap.mjs` deliberately refuses to read routes from disk, so the routes had to live in content.
**Action for you:** decision 3's wording should list `content/pages.json` beside `tools.json` and
`targets.json`. That document lives outside the repo, so it is the one edit I cannot make.

### Ruling 2 — the homepage is now generated (was the last hand-written metadata)

Closed. `scripts/build-pages.mjs` renders `src/index.html` from `src/templates/site.template.html` plus
`src/templates/home.html`, so its canonical, `og:url`, title, description and OG tags all come from
`content/site.json`. The comment warning that the origin was duplicated in two places went with the file it
was in, and the placeholder audit now covers the homepage too (11 pages, up from 10).

`content/site.json` gained `tagline`, and the homepage title is built as `"<name> — <tagline>"`, which
reproduces exactly the title that used to be hand-written.

**Consequence to be aware of:** the hand-written meta description ended with an extra sentence — "No
sign-up, no tracking, no server." — that `site.json`'s description does not contain, so the meta description
is now the shorter `site.description` text. The claim itself still appears on the page, in the homepage
body prose. Folding it back into the meta description is a one-line edit to `site.json`.

### Ruling 3 — one reference key for "this points at that tool"

Changed. `targets.json` entries now carry `parentToolId` (a tool **id**) instead of `parentTool` (a slug),
matching how `related` already worked. Rationale: ids are stable, slugs are URLs and have already changed
once (`compress` → `compress-image`); a slug reference would have turned that rename into a broken build,
or worse, a page linking nowhere. `content/targets.json` is empty today, which made this the cheapest
possible moment to fix.

- `scripts/lib/content.mjs` validates `parentToolId` against the tool ids, failing with
  `"parentToolId" ("compress-image") is not an id in content/tools.json`.
- `scripts/build-targets.mjs` and `scripts/gen-sitemap.mjs` pass `tools.map((tool) => tool.id)`.
- `tests/content.test.js` gained a `target()` fixture and two tests: the id resolves; a *slug* is refused;
  a missing field, a non-kebab-case value and a duplicate target slug all fail.

Proven live rather than by inspection: with a temporary entry carrying `parentToolId: "compress-image"` the
build failed with that exact message and wrote nothing; with `parentToolId: "compress"` it generated
`src/targets/compress-image-to-100kb/index.html` linking to `/tools/compress-image/` and added the route
(8 total). Both were reverted — `content/targets.json` is `[]` again and the sitemap is back to 7 routes.

### Ruling 4 — ZIP packaging stays on the main thread

Recorded, no code change. `fflate.zipSync` at stored level in `core/file-io.js` is a memcpy of
already-compressed bytes rather than a compression, and the download has to be triggered from the main
thread regardless — so the part that could move is the cheapest part of the operation. Decision 2's list
("compression, resizing, format conversion, AI segmentation") is read as not covering it. If batches ever
grow into the hundreds of megabytes, this is the first thing to revisit.

### Also changed in this pass

- **The Phase 0 playground is gone.** `src/assets/js/home-demo.js` is deleted, the `.playground*` block is
  removed from `components.css`, and the regenerated homepage carries no trace of either. It was always
  marked throwaway, and the real tool now exercises the dropzone properly — `dropzone.js`'s only remaining
  consumer is `assets/js/tools/compress-image.js`.
- **Cosmetic:** the generated homepage has one blank line before `</div>`, matching the shape the other
  generated pages already have (the body file ends with a newline, the wrapper template adds its own).
  Deliberately left alone — consistency with existing output beat a one-off special case.

### Verification performed (Bun 1.4.2 standing in for Node, which is not installed here)

- `bun test tests/` → **72 pass, 1 fail**. The failure is the pre-existing
  `Cannot find package 'fflate'` in `tests/file-io.test.js`, which `npm install` resolves.
  `tests/content.test.js` on its own: **12 pass, 0 fail**.
- All four generators, run twice: `build-pages` up to date (15 files), `gen-sitemap` up to date (7 routes),
  `build-targets` up to date, `gen-og` up to date.
- The regenerated homepage expanded through the plugin's own include algorithm: 2 rounds, **0 leftover
  include comments**, 5 tool cards, 6 header nav links, 5 footer links, theme and menu hooks present,
  `site.js` present, **0** `href="#"`, **0** references to the playground or the deleted harness.
- `grep -rn parentTool src/ scripts/ tests/` returns only `parentToolId` (the reference) and
  `parentToolName`/`parentToolPath`/`parentToolIntro` (tokens the generator fills from the resolved tool).
  No bare slug reference survives anywhere.

### Still not verifiable on this host

- `npm install`, `npm run test`, `npm run dev`, `npm run build`, and how the regenerated homepage actually
  looks in a browser. There is no Node and no browser here, so the homepage's appearance and the
  directory-style URLs remain your checks.
- One operational note worth knowing: the generators are independent, so `npm run gen` (chained with `&&`)
  stops at the first failure but does not roll back files already written. A malformed `targets.json`
  therefore fails *after* the page files are written; the content files themselves stay untouched.

### Open decisions (unchanged, still yours)

1. The canonical origin — `https://example.com` in `content/site.json`, flagged by the audit on 11 pages
   and hard-coded in `public/robots.txt` and `public/sitemap.xml` through it.
2. The contact address (`hello@example.com`) and the optional repository URL.
3. The governing-law marker in the terms page.
4. A real 1200×630 PNG for `og:image` — needs a rasterizer that is not on the approved library list.
5. The hosting provider, described generically in the privacy policy rather than marked `TO CONFIRM`, since
   a marker mid-sentence would read badly.

---

## Phase 3 — Resize, Convert, Crop, Image-to-PDF

Four new tools, all live, all on the Phase 1 pattern. Nothing duplicated: one dropzone, one queue, one
ZIP writer, one compare slider, one encoder.

### Acceptance checklist

| # | Criterion | Status |
|---|---|---|
| 1 | All four tools work standalone with correct output | **Implemented; runtime verification is yours.** Every tool has an engine, a worker, a wired page and a capability gate. No browser and no Node exist on this host, so “works” cannot be asserted here — see *Not verified here* below. |
| 2 | None duplicates the dropzone/queue/UI components | **Verified by grep** — the import table below, plus `0 zipSync` and one `createDropzone` call per tool. |
| 3 | Batch + ZIP where applicable | Resize, convert, PDF batch; **crop is single-image by your ruling**, so ZIP applies to two tools and single-PDF output to a third. |
| 4 | tools.json + generated pages correct and linked from the homepage | **Verified**: 5 live tool pages, 5 cards in the homepage grid, 0 `coming soon` badges, 11 sitemap routes, all four generators idempotent. |

### What each tool reuses (acceptance 2, as printed evidence)

| Tool | Shared core | Shared UI | Own engine + worker |
|---|---|---|---|
| compress-image | queue, file-io, engine-compress, errors | dropzone, compare-slider, progress, format | engine-compress + compress.worker |
| resize-image | queue, file-io, engine-resize, engine-compress, **presets** | dropzone, compare-slider, progress, format | engine-resize + resize.worker |
| convert-image | queue, file-io, engine-convert, **formats** | dropzone, compare-slider, progress, format | engine-convert + convert.worker |
| crop-image | file-io, engine-crop, **presets**, engine-compress | dropzone, compare-slider, progress, format | *(none — it encodes through convert.worker)* |
| image-to-pdf | queue, file-io, engine-pdf | dropzone, progress, format, **order-list** | engine-pdf + pdf.worker |

Every tool script contains exactly one `createDropzone(...)` call and zero `zipSync` calls. Reordering needed a
component that did not exist, so `ui/order-list.js` is new and written as reusable rather than inline.

### The two prerequisites, and how they went

**The template gate.** `tool.template.html` is now a shell with a `{{{body}}}` slot, and each live tool’s panel
lives in `src/templates/tools/<slug>.html` (five fragments), mirroring `templates/pages/<slug>.html`. The gate
held: after moving compress’s entire body into its fragment, `build-pages` reported **0 files written**, i.e. all
15 generated files were byte-identical. All 18 of the compress page’s runtime hooks were re-counted afterwards
and are intact.

**The pica spike did not happen.** It was meant to run in a browser before the resize UI was built, and there is
no browser here — so the resize tool was built on the documented API and the spike is now the *first* thing to
run, not the last. What it must answer is stated in *Not verified here*.

### Decisions

1. **pica runs with `features: ['js']` and `resizeBuffer`.** The default feature list includes `ww`, which spawns
   a Worker inside our worker, needs a `workerURL` under a strict CSP, and is not supported everywhere. Since we
   are already off the main thread, the pure-JS maths core is the right tool. `wasm` is a one-word change once it
   is shown to load cleanly under Vite. `resizeBuffer` is documented as “not recommended for direct use” because
   it skips tiling — which is exactly why it fits a worker: no internal canvas, no nested workers, and raw RGBA
   is what we already hold. Peak memory is the trade, bounded by the pixel budget before any work starts.
2. **cropperjs is pinned to `1.6.2`, not 2.x.** Evidence, read from the shipped package rather than assumed:
   2.2.0’s types expose `$toCanvas()` on `CropperCanvas` only — there is no `$toCanvas()` on `CropperSelection`
   and no `$getTransform()` on `CropperImage` — while both exist on `main` (unreleased) and in the docs. The
   selection rectangle is also expressed in the *view’s* CSS pixels, which is visible in the official
   `$toCanvas` implementation where the selection’s `x`/`y` are used directly as context translates. So 2.2.0
   offers no supported route from “this selection” to full-resolution pixels. 1.x answers it with one documented
   call, `getCroppedCanvas()`, which returns the selected region at natural resolution with rotation and flips
   applied. This is the fallback the approved plan named; it is now the live path.
3. **HEIC uses `heic-to` (LGPL-3.0), loaded lazily, with compliance steps.** Native `createImageBitmap` first, so
   Safari never fetches anything; only when that throws does the worker `await import('heic-to')`, which makes
   Vite emit it as a separate chunk fetched from this origin. Verified API: `heicTo({ blob, type: 'bitmap' })`.
   The version is pinned exactly (`1.5.2`) so the shipped binary matches the notice, and `heic-to/csp` is the
   documented escape hatch for a strict CSP. **Still to do, and it is yours to review:** the privacy page needs
   the third-party components section naming `heic-to` and libheif with the LGPL-3.0 license line and upstream
   source links. I did not write it in this pass, and it should not ship without it.
4. **AVIF is out of convert’s outputs** (your ruling). Canvas cannot write AVIF and Chrome silently returns a
   PNG, so the format list is now built from a runtime probe: a 1x1 `convertToBlob` per candidate format, with
   `blob.type` read back. A requested format the browser cannot write is refused with a message naming what it
   can, and the worker double-checks the returned type before handing anything back. The FAQ gained an entry
   explaining exactly that, and the `convert to avif` keyword became `heic to jpg` / `avif to jpg` (both are
   input formats we do handle).
5. **Crop is single-image** (your ruling): no queue, no ZIP, and a second drop replaces the first.
6. **Crop encodes through `convert.worker.js`.** The cropped canvas becomes a PNG blob on the main thread (a DOM
   canvas has no worker equivalent) and the real encode happens in the convert worker. One encoder in the
   project, not two. This is main-thread work by necessity, like the crop itself — the same class of exception
   the ZIP decision already records.
7. **PDF: PNG passes through, everything else is redrawn as JPEG.** pdf-lib embeds a JPEG byte-for-byte, EXIF
   orientation included, so a portrait phone photo would land on its side unless it is redrawn first; PNG has no
   orientation metadata, so its bytes go in untouched and losslessly. Every page is measured from the decoded
   bitmap, so layout always matches what is drawn. PDF assembly reuses `core/queue.js` at concurrency 1 — that is
   what gives per-image progress, ordered results, retry and a cancel that reaches the worker, and concurrency 1
   is a memory decision because prepared pages are held until the document is written.
8. **Two extractions, both to avoid a second copy of the same facts.** `core/formats.js` now owns the mime labels,
   extensions and the opaque/heic sets that `engine-compress.js` and `file-io.js` each had their own version of;
   `core/inputs.js` owns the two typed-number parsers. Both original modules re-export what they used to define,
   so no import anywhere changed and no engine has to pull in fflate to know what “jpg” means.
9. **Rotate is quarter turns only.** The crop tool rotates in 90-degree steps and flips; free-angle straightening
   is not offered. The crop FAQ says so in as many words rather than leaving the keyword list to imply otherwise,
   and `circle crop` was removed from the keywords because this tool does not do it.

### Preset data, sourced rather than guessed

Each preset records where its number came from, and the two YouTube values are quoted from Google’s own help
page (`support.google.com/youtube/answer/72431`): **3840×2160** for video thumbnails, **2160×3840** for Shorts,
minimum 640 px. This is why the commonly repeated 1280×720 is *not* the preset. The four Instagram entries are
marked `derived: true` and carry no URL, because Instagram publishes aspect-ratio limits rather than pixel tables
and a guessed documentation link would be worse than an honest description. Passport/ID presets are deliberately
absent: GOV.UK’s digital spec is “at least 600 pixels wide and 750 pixels tall” and it states “do not crop your
photo — it will be done for you”, which is the opposite of what this tool does.

### Verification performed (Bun 1.4.2 standing in for Node)

- `bun test tests/` → **126 pass, 1 fail**, 127 tests across 10 files. The failure is the pre-existing
  `Cannot find package 'fflate'` in `tests/file-io.test.js`, which `npm install` resolves.
- **43 JS/MJS files** syntax-checked, all parse — including all four new workers and all five tool scripts.
- All four generators twice: `build-pages` up to date (15 files), `gen-sitemap` up to date (11 routes),
  `build-targets` up to date, `gen-og` up to date.
- Generated pages expanded through the plugin’s include algorithm: **0 leftover include comments**, header, footer
  and `site.js` present on all four new pages, **0** `href="#"`, and every `data-*` hook each tool script queries
  is present in its page.
- Homepage grid: 5 cards, **0** “coming soon” badges.
- Privacy greps: no `fetch(`, no `XMLHttpRequest`, no analytics, no third-party origin in shipped source. The only
  `https://` strings are documentation URLs stored as *text* in `presets.js` for the preset note (never
  requested), plus the trust pages’ own prose about not having analytics.
- `heic-to` appears in exactly one file — the convert worker — and only as a dynamic import.
- Licenses and versions confirmed against the npm registry: cropperjs 1.6.2 (MIT), heic-to 1.5.2 (LGPL-3.0),
  pica 10.0.3 (MIT), pdf-lib 1.17.1 (MIT). No library outside the approved list was added.

### Not verified here (yours to run)

No Node and no browser on this host, so **every runtime claim about these four tools is unverified**:

1. **The pica spike, first.** `npm install`, then open `/tools/resize-image/` and resize one image. If pica cannot
   run inside our worker with `features: ['js']` and `resizeBuffer`, the resize tool needs a different resampler,
   and the failure will be a worker error rather than a wrong-looking image. This is the phase’s biggest unknown.
2. `/tools/crop-image/` with cropperjs 1.6.2 — drag, ratio presets, rotate, flip, apply. If the installed cropper
   is ever bumped to 2.x, the tool announces that its crop export is unavailable rather than half-working.
3. `/tools/convert-image/` in Chrome and Firefox: the format list should differ between them if their encoder
   support differs, and a HEIC drop should show the decoder notice, then fetch the decoder from this origin.
   **Check the Network tab: no request should leave this origin.**
4. `/tools/image-to-pdf/` with a portrait photo, a landscape photo and a PNG: page orientation should follow each
   image, PNG should stay lossless, and the PDF should open with pages in list order.
5. Batches: drop 5+ images on resize, convert and PDF, with the UI staying responsive and a ZIP (or one PDF)
   arriving at the end.

### Deviations from the approved plan

1. **cropperjs 1.6.2 instead of 2.x**, for the reason recorded above. Two consequences worth stating: the crop
   tool’s rotate/flip are cropper’s own methods, and **`engine-crop.js`’s transform maths is tested but not on the
   live path** — it is kept deliberately, with tests, because it is exactly what a v2 migration would need once
   `selection.$toCanvas()` ships. That is unused-but-tested code, and it is flagged rather than hidden.
2. **AVIF removed from convert’s advertised outputs** (approved), which also required FAQ and keyword edits.
3. **Crop is single-image**, so acceptance criterion 3 applies to three tools rather than four.
4. **EXIF stripping is not implemented**, exactly as instructed — it is called out here as an undone extra, not
   folded in. What *is* done is `imageOrientation: 'from-image'` on every decode, because without it every
   portrait phone photo would come out sideways in resize, convert and PDF. That is correct decoding, not
   stripping.
5. **The privacy page’s LGPL notice is still to write** (decision 3 above).
6. One decision not in the plan: **PDF embeds PNG unchanged and redraws JPEG**, for orientation correctness.
7. `core/formats.js` and `core/inputs.js` are two files the plan did not list.

### Files

**Created (16):** `core/formats.js`, `core/inputs.js`, `core/presets.js`, `core/engine-resize.js`,
`core/engine-convert.js`, `core/engine-crop.js`, `core/engine-pdf.js`, `workers/resize.worker.js`,
`workers/convert.worker.js`, `workers/pdf.worker.js`, `ui/order-list.js`, `tools/resize-image.js`,
`tools/convert-image.js`, `tools/crop-image.js`, `tools/image-to-pdf.js`, `templates/tools/*.html` (5),
`tests/{resize,convert,crop,pdf,order-list}.test.js` (5).

**Modified (8):** `templates/tool.template.html` (now a shell), `scripts/build-pages.mjs` (fragment rendering),
`content/tools.json` (four tools live, copy rewritten), `package.json` (four dependencies),
`assets/js/core/engine-compress.js` and `assets/js/core/file-io.js` (re-exports),
`assets/css/components.css` (Phase 3 block), `PROGRESS_LOG.md`.

**Regenerated, never hand-edited:** the five tool pages, four partials, `sitemap.xml`, `robots.txt`.

### What Phase 4 should assume exists

- Five live tools, each = one `templates/tools/<slug>.html` fragment + one `tools/<slug>.js` + one worker, with
  `content/tools.json` as the only metadata source and `status` deciding everything.
- Worker contract: comlink, `capabilities()` probed lazily (never a top-level await, so `Comlink.expose` always
  runs during module evaluation), one `AbortController` per job, plain `{ code, message }` errors.
- `core/queue.js` driving every batch, `core/file-io.js` doing every ZIP, `ui/order-list.js` for ordering.
- `core/presets.js` as the home for sourced platform numbers, with `derived` marking arithmetic.
- **A licence obligation**: `heic-to` is LGPL-3.0 and shipped to visitors. Any future phase that touches the
  privacy page or the dependency list inherits the requirement to keep its notice, exact pin and source link
  accurate.

---

## Phase 4 — Long-Tail Target Pages Engine (completed)

### What shipped

A target page is not a new kind of page: it is **the parent tool's own page with a different head, a different
intro, a pre-set default and a body of content**. So rather than build a second renderer, the tool-page rendering
that already existed was extracted into `scripts/lib/tool-page.mjs` and both generators now call it. A target page
renders `src/templates/tools/<parent-slug>.html` — the same fragment file the tool page renders — through the same
`#tool-config` contract, with the target's `defaultOption` added as `defaults`.

- **14 target pages** under `src/targets/<slug>/`: 3 × compress, 3 × resize, 4 × convert, 2 × crop, 2 × image-to-pdf.
- **4,914 words of unique content** in `content/targets.json`, **324 to 399 words per entry** — every one above the
  250-word floor on its own merits, none of them the same text with a number swapped.
- Tool pages gained a generated **Guides and use cases** section; target pages link to their **siblings**; the
  sitemap went from 11 to **25 routes**; Vite picks up all 25 entries with **no config change** (the recursive
  `findPageEntries()` walk was already there from phase 0).

### The content gate (acceptance 1)

`MIN_UNIQUE_WORDS = 250` and one exported `countWords()` shared by the build and the tests, so the gate and its
verification cannot disagree. Five refusal cases were proven against the real generator, each with exit code 1 and
nothing written:

```
content/targets.json[2]: "uniqueContent" is 36 words — a target page needs at least 250 words of content
  that appears nowhere else. Write about this exact use case, or drop the entry.
content/targets.json[0]: "uniqueContent" is required and must be a non-empty string
content/targets.json[0].defaultOption: "targetSizeKb" is not an option of tool "compress".
  Pre-settable options are: targetSizeKB
content/targets.json[3].defaultOption: "presetId" must be an id from RESIZE_PRESETS: instagram-square,
  instagram-portrait, instagram-landscape, instagram-story, youtube-thumbnail, youtube-shorts-cover,
  hd-1080p, web-1280. Received "instagram-square-ish"
content/targets.json[0]: "faq[0].a" still contains [VERIFY] and this entry is live. Confirm the fact and
  remove the marker, or keep the entry "planned" until it is checked.
```

The last one is the ruling from the constitution audit: **an unresolved `[VERIFY]` on a live entry fails the
build**. The sweep covers every published field — title, description, h1, intro, uniqueContent and each FAQ item —
not just the prose, because a claim is a claim wherever it is printed. All 14 shipped entries contain zero markers,
so no fact on these pages is one I could not check.

### The schema an entry now has

`slug`, `parentToolId`, `status`, `navLabel`, `title`, `description`, `h1`, `intro`, `targetKeyword`, `keywords`,
`defaultOption`, `uniqueContent`, `faq[]`.

`uniqueContent` is a string with a deliberately tiny markup subset: blank-line paragraphs, `"## "` headings,
`"- "` lists, and no inline HTML. `parseUniqueContent()` is pure, so the validator and the renderer agree on what
a block is, and text is escaped on the way out — `<script>` in content comes out as text. Blocks that mix those
forms are a build error rather than a half-rendered list.

`defaultOption` is allowlisted per tool **and type-checked**, because a typo'd key would produce a page that claims
to be pre-configured and quietly is not:

| parent | allowed keys | value checked against |
|---|---|---|
| `compress` | `targetSizeKB` | positive integer |
| `resize` | `presetId` \| `width`/`height` | `RESIZE_PRESETS` ids / positive integers |
| `convert` | `outputMime` | the tool's own `outputs` in `tools.json` |
| `crop` | `ratioId` | `CROP_RATIOS` ids |
| `image-to-pdf` | `pageSizeId`, `marginId`, `qualityId` | `PAGE_SIZES` / `MARGINS` / `QUALITIES` |

Those enum lists are **imported from `core/presets.js` and `core/engine-pdf.js`**, never copied into the build, so
there is still exactly one place a preset id exists. `presetId` together with `width`/`height` is refused, because
a page must not be able to disagree with itself about its own size.

### The extraction gate (no regression to phase 1–3 work)

After moving the rendering into `tool-page.mjs` and changing `ogTags()` to take `site` explicitly,
`build-pages` reported **15 files unchanged** — byte-identical output, before any template changed. Once the
guides section was added deliberately, exactly **5 tool pages changed, 1 hunk each, additions only, 0 deletions**.

### Verification actually performed (Bun 1.4.2 standing in for the absent Node)

- `bun test tests/` → **140 pass, 1 fail, 1 error**; the failure is `tests/file-io.test.js` unable to resolve
  `fflate`, the known `npm install` case since phase 1. `tests/targets.test.js` alone: **13 pass, 0 fail**.
- **Every one of the 14 pages**, expanded through the plugin's include algorithm: 0 unexpanded includes, one
  `data-tool-root`, one `data-dropzone`, one `#tool-config`, the parent's own script and parent link present,
  `data-unique-content` + `data-faq` + `data-guides` + `data-parent-tool-cta` present, and **every `/assets/...`
  path the pages reference exists on disk**.
- The config block on each page was parsed back out and its `defaults` object compared to the entry's
  `defaultOption` — that is what makes "pre-configured" testable rather than claimed.
- **Idempotency**: the full chain run twice reports `up to date` four times over on both passes.
- **Privacy greps** over the new pages: 0 hits for `fetch(`, `XMLHttpRequest`, `cdn.`, `googleapis`, `analytics`,
  `gtag`; the only `https://` strings are the `example.com` placeholders already tracked as open decisions.
- An **independent word count** (a different algorithm from `countWords`) per entry, printed by the generator and
  re-checked by the test suite: every entry clears 250, with 74 to 149 words of headroom.

### Acceptance checklist

| # | Criterion | Status |
|---|---|---|
| 1 | Build fails loudly, naming the entry, when `uniqueContent` is missing or short | **Proven** — five cases, exit 1, nothing written, exact messages quoted above |
| 2 | Each target page has a correct canonical, links back to its parent, and its own FAQ | **Verified on disk** for all 14 (canonical `/targets/<slug>/`, parent link in the breadcrumb and the CTA, `data-faq` from the target's own `faq` array) |
| 3 | List every page generated, none under 250 words | **Printed by `npm run gen:targets`** on every run, cross-checked by the test suite and by an independent counter — table in the close-out |

### Decisions worth knowing

- **`navLabel` was added to the schema.** A card needs a short label; `title` is a full SEO headline and `h1` is a
  sentence. This is the one field beyond the phase's own field list.
- **Sibling guides and the tool-page Guides section are additions.** Without them a target page is reachable only
  by crawling the sitemap, because nothing links to `/targets/`. Both are generated from `targets.json`.
- **`toolConfig()` omits `defaults` entirely when there is none**, which is why tool pages stayed byte-identical.
- **A planned target generates no page and is reported as parked**, rather than getting a noindex page the way a
  planned tool does. Parked is for a draft that still carries a `[VERIFY]` marker; the generator prints it by name.
- **The parent tool must be live for *every* target**, not just live ones: a planned tool has no panel fragment to
  render, and a target page without its working tool is a stub.
- **`targetKeyword` must be unique.** Two pages chasing one query cannibalise each other, which is the opposite of
  what a long-tail page is for.
- **Each page states its own default in words** — "Pre-set for you: a 100 KB target file size per image. You can
  change it before you drop a file." — so a visitor can tell what the page is for and that nothing is locked.

### Deviations from the approved plan

- The plan said `describeDefaultOption(tool, option)`; it takes just the option, because the phrasing comes from
  the shared preset lists rather than from the tool.
- The `[VERIFY]` sweep was broadened from `uniqueContent` to every published field (see above).
- The duplicate-keyword check and the "no two entries share a sentence or a question" test were not in the plan.
  The latter is the closest mechanical proxy for "no template filler": it caught nothing in this batch (0 shared
  8+ word sentences, 0 repeated FAQ questions), and it will catch it next time.
- `content/tools.json` was **not** touched. Its `compress` keyword list still claims "compress image to 100kb",
  which `/targets/compress-image-to-100kb/` now serves better. Flagged for your call, not silently changed.
- No `robots`/noindex mechanism was added for targets, per the parked-draft decision above.

### Files

**Created (16):** `scripts/lib/tool-page.mjs`, `tests/targets.test.js`, and the 14 generated
`src/targets/<slug>/index.html` pages.

**Modified (15):** `content/targets.json` (14 entries), `scripts/lib/content.mjs` (word gate, block parser,
`defaultOption` validation, `[VERIFY]` gate, `loadTargets(tools)` signature), `scripts/build-targets.mjs` (rewritten
around the shared renderer + the word-count report), `scripts/build-pages.mjs` (imports from the shared lib plus the
Guides section), `scripts/gen-sitemap.mjs` (call site), `src/templates/target.template.html` (rewritten),
`src/templates/tool.template.html` (guides slot), the five `src/assets/js/tools/*.js` (pre-fill),
`src/assets/css/components.css` (`.tool-hint`), `tests/content.test.js` (new fixture fields), `PROGRESS_LOG.md`.

**Regenerated, never hand-edited:** 14 target pages, 5 tool pages, `public/sitemap.xml` (`robots.txt` unchanged).

### Still to verify by hand (browser only — no browser on this host)

1. On each of the five pre-filled pages, the control shows the target's value **at load** and **no work starts**
   before a file is dropped. That is the one behaviour the pre-fill change could break.
2. `/targets/resize-image-to-1080x1080/` — the preset note is visible and the width/height boxes are filled and
   disabled, exactly as if the preset had been chosen by hand.
3. `/targets/convert-heic-to-jpg/` — JPEG is selected **only if this browser can write JPEG**. On a browser that
   cannot, the select falls back rather than lying about the output.
4. `/targets/crop-image-to-square/` — the 1:1 button starts pressed and the ratio is locked before an image is
   dropped.
5. `/targets/image-to-pdf-a4/` — page size A4, normal margins, balanced quality already selected.
6. Regress `/tools/compress-image/`: the Guides cards at the bottom, then the tool itself.

### What Phase 5 should assume exists

- **14 live target pages**, each rendering its parent's fragment and script with `defaults` in `#tool-config`. A
  tool-page markup change must go through `scripts/lib/tool-page.mjs` or the target pages drift.
- Exported from `scripts/lib/content.mjs`: `MIN_UNIQUE_WORDS`, `VERIFY_MARKER`, `countWords()`,
  `parseUniqueContent()`, and the `TARGET_DEFAULT_OPTIONS` allowlist. `loadTargets()` takes **tools**, not ids.
- **Schema.org has what it needs already**: one `h1` per page, `intro`, `uniqueContent` rendered as `<p>`/`<h2>`/
  `<ul>` inside `[data-unique-content]`, FAQ items as `<details class="faq-item" data-faq-item>` under `[data-faq]`,
  and a breadcrumb `<nav aria-label="Breadcrumb">` with `aria-current="page"` on both page kinds.
- `[data-guides]` marks the generated internal-link blocks on both tool pages and target pages.
- The origin is still `https://example.com` — 25 pages now carry it in their canonical, and the placeholder audit
  prints that on every run. It is the single highest-value open decision before launch.

---

## Phase 5 — Technical SEO Layer (completed)

### What shipped

| Piece | Where | Notes |
|---|---|---|
| JSON-LD, one `@graph` per page | `scripts/lib/schema.mjs`, both generators | WebSite + Organization (home), SoftwareApplication (live tools), FAQPage (where an FAQ exists), BreadcrumbList (everything but home) |
| A validator for those graphs | `validateGraph()` in the same file | Called by the tests **and** by the audit, so there is one definition of "valid" |
| Social cards | `scripts/lib/og-card.mjs` (model/layout), `scripts/gen-og.mjs` (rasteriser) | 25 PNGs at 1200×630 in `public/og/`, plus an SVG source per card and a preview sheet |
| hreflang scaffolding | `content.mjs`: `localePath`, `pageUrl`, `alternateLinks`, `localeSrcDir`, `pageFile`, `partialsPrefix`, `siteRoutes` | One locale configured; adding a second is a `site.json` change, and nothing moves |
| The route inventory, in one place | `siteRoutes()` in `content.mjs` | The sitemap generator and the audit both read it — a route that exists in one list and not the other is exactly the drift this removes |
| Reserved ad space, no ad markup | `.ad-slot` contract in `components.css` + `adSlotsHtml()` | `site.json` has `"ads": false`, so **0** generated pages contain ad markup today |
| A static SEO gate | `scripts/audit-seo.mjs` (`npm run audit:seo`) | Exits non-zero on a broken page; wired into `prebuild` |
| `pdf-lib` off the critical path | `pdf.worker.js` now does `await import('pdf-lib')` | The only non-SEO code change in this phase; same precedent as `heic-to` |

### The two acceptance criteria I could not satisfy as written, and what I did instead

**Criterion 1 (Lighthouse SEO = 100) and criterion 4 (actual Lighthouse Performance numbers) cannot be
answered on this host.** There is no browser, no Node and no npm here, and Lighthouse needs a real browser to
measure anything. Inventing a score would be worse than reporting nothing, so instead:

- `npm run audit:seo` mechanically checks the part of Lighthouse's SEO category that is a property of the
  HTML: unique `<title>`, meta description length, self-referential absolute canonical, `lang`/`dir`, mobile
  viewport, hreflang alternates, exactly one `<h1>` with no skipped level, `alt` on every image, no `href="#"`
  and no unlabelled anchor, one valid JSON-LD graph with the pages' expected node types, OG URLs that resolve
  to files on disk, every `/assets/...` reference existing, no off-origin resource, sitemap↔page parity with
  reciprocal alternates, robots.txt pointing at the real origin, and no unresolved partial include.
- Current result: **0 errors, 9 warnings** across 25 pages (25 share images, 1 locale). The warnings are the
  nine strings that will be truncated in search results, and they are listed verbatim in the audit output —
  see *Open items* below rather than "fixed" by quietly editing content in an SEO phase.
- The audit is itself tested, including a negative proof: `tests/seo.test.js` renames
  `src/tools/compress-image/index.html` out of the way, asserts the audit reports
  `is missing — … has no file on disk` **and exits non-zero**, then restores it. A gate that cannot fail is
  not a gate.

**Performance, measured as far as this host allows** (bytes are real; none of these are Lighthouse metrics):

- All three stylesheets, which every page render-blocks on: **24.4 KB minified, 5.4 KB gzip, 4.6 KB brotli**
  (`base.css` 3.8 KB min, `layout.css` 3.5 KB, `components.css` 17.1 KB).
- Main-thread JS: the homepage loads **1.7 KB minified (0.7 KB gzip)** — `site.js` and nothing else. The
  heaviest tool script is `resize-image.js` at **13.4 KB minified (5.0 KB gzip)**; the others are 6.9–12.2 KB
  min. Vendor code (comlink, and cropperjs for the crop page only) is shared chunks on top of that.
- Static HTML per page: 4.2 KB (home), 13.5 KB (`/tools/image-to-pdf/`), 18.2 KB (`/tools/compress-image/`).
- **LCP on the homepage is text, not an image**: the page contains 0 `<img>` elements. So is
  `/tools/image-to-pdf/`. `/tools/compress-image/` has 2 `<img>`, both inside a result panel that is
  `hidden` until a file is processed, and both inside `.compare-slider` (`min-height: 240px`, absolutely
  positioned panes) — so the LCP image cannot shift anything, and there is no above-fold image to prioritise.
- **No font fetch and no font swap**: the CSS uses a system stack (`--font-sans`), there is no `@font-face`
  and no `preload`, so no FOIT/FOUT and no font-driven CLS. The only vendored font is build-time only.
- **CLS has nothing reserved to move into**: `site.ads` is false, so the generated pages contain no ad box at
  all. When it flips to true, `.ad-slot-leaderboard` reserves 100 px (90 px at ≥728 px) and
  `.ad-slot-rectangle` 250 px, with `contain: layout paint`, and slots are placed *below* the tool panel or
  inside the prose, so a reserved box can never become the LCP element.

### Structured data — what validates, and one fact that changed this phase's shape

Every page emits exactly one `<script type="application/ld+json">` containing one `@graph` with one
`@context`. Nodes carry stable fragment `@id`s (`…#website`, `…#organization`, `…#software`, `…#faq`,
`…#breadcrumb`) and the audit asserts that at least one node is anchored to the page's own URL, that no `@id`
repeats, that breadcrumb positions run 1..n in order, and that `url`/`item`/`image`/`logo` values are absolute.

**Google retired the FAQ rich result.** From Google's own documentation changelog: 8 May 2026 — *"This
feature will no longer appear in Google Search starting May 7, 2026"*; 15 June 2026 — *"Removed documentation
for the FAQ rich result feature."* The supported-features gallery now lists Q&A *Pages* (a page that is one
question with answers) and no FAQ markup at all. `FAQPage` is still valid schema.org and is still read by
non-Google consumers, so it is emitted — but **it now earns nothing in Google**, and the audit's real value
here is the other half of the check: every question in the JSON-LD must also be *visible on the page*,
because schema-only FAQ content was always a guidelines violation. Whoever reviews this later should not
spend a morning wondering why FAQ markup produced no rich result.

Nor is there an `aggregateRating` on the `SoftwareApplication` nodes: we have no ratings, and inventing them
would be both dishonest and a guidelines violation. Google's Software App feature is aimed at rated apps, so the
Rich Results Test may say the page is not eligible for that one feature. That is expected, not an error.

Sample page JSON-LD to paste into the Rich Results Test — `/tools/compress-image/` (regenerate with
`npm run gen` first, then copy the block out of `src/tools/compress-image/index.html`):

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": "https://example.com/tools/compress-image/#software",
      "name": "Compress Image",
      "applicationCategory": "MultimediaApplication",
      "operatingSystem": "Any (web browser)",
      "isAccessibleForFree": true,
      "offers": { "@type": "Offer", "price": 0, "priceCurrency": "USD" }
    },
    { "@type": "FAQPage", "@id": "https://example.com/tools/compress-image/#faq", "mainEntity": ["…"] },
    { "@type": "BreadcrumbList", "@id": "https://example.com/tools/compress-image/#breadcrumb", "itemListElement": ["…"] }
  ]
}
```

### Social cards: satori + resvg-js, and their licences

`gen-og.mjs` renders each card's layout with **satori** and rasterises the resulting SVG with
**`@resvg/resvg-js`**. satori was chosen over sharp because sharp is a *raster* toolkit: drawing text with it
means opening an SVG or a canvas, so the layout engine would have had to be chosen anyway — and both of these
are dev-only, small, and need no native build step beyond the platform binary that ships with resvg-js.

Both are **build-time dependencies only**. They are not imported by anything under `src/`, they are never
bundled into the site, and nothing in them is served to a visitor. As with `heic-to`, the licence lines are
quoted here because they are not on the approved library list:

| Package | Version (pinned exactly) | Licence | Source |
|---|---|---|---|
| `satori` | 0.33.4 | `"license":"MPL-2.0"` — shipped `LICENSE` begins *"Mozilla Public License Version 2.0"* | <https://registry.npmjs.org/satori/0.33.4>, <https://unpkg.com/satori@0.33.4/LICENSE> |
| `@resvg/resvg-js` | 2.6.2 | `"license":"MPL-2.0"` — shipped `LICENSE` begins *"Mozilla Public License Version 2.0"* | <https://registry.npmjs.org/@resvg/resvg-js/2.6.2>, <https://unpkg.com/@resvg/resvg-js@2.6.2/LICENSE> |
| IBM Plex Sans (fonts) | OFL-1.1 | *"Copyright © 2017 IBM Corp. with Reserved Font Name \"Plex\" … licensed under the SIL Open Font License, Version 1.1"* | vendored with its own `LICENSE.txt`; provenance, commit and checksums in `scripts/assets/fonts/README.md` |

MPL-2.0 is file-level copyleft and explicitly permits a larger work under other terms (§3.3), so it would not
reach the site even if it shipped — and it does not ship. **Flagging it anyway**, because satori's reputation is
MIT and its published licence is not: the change is visible in the registry metadata for the pinned version,
not just the README. Licence facts the user has not pre-approved are theirs to accept.

`gen-og.mjs` writes the SVG card unconditionally for every page and the PNG when the rasteriser resolves,
because the SVG is the source of truth for the layout and a missing PNG is visible (the audit errors on it)
where a missing SVG is only inconvenient. It also writes `scripts/assets/og-preview.html` — a contact sheet of
every card, rendered from **the same element tree** the rasteriser consumes, so a preview cannot drift from
what ships. The PNGs are checked on disk as real 1200×630 PNGs with a non-trivial byte size; **they have not
been looked at with eyes**, because this host cannot composite a preview.

### hreflang scaffolding — what works, and the one gap that is now a build error

One locale is configured, so today every page emits a self-referencing `en` alternate plus `x-default`, and
`public/sitemap.xml` carries the matching `<xhtml:link>` for all 25 routes. Adding a second language means:
adding it to `content/site.json` → `locales`, and (optionally) adding `content/<code>/<file>.json` translation
files, which the loaders overlay field-by-field and report by name when an entry is untranslated. Non-default
locales write to `src/<code>/…`, use `src/partials/<code>/…` for their includes, and file their social cards
under `/og/` in their own directory. None of that moves an existing URL.

**The gap:** internal links inside a page are emitted as default-locale paths (`/tools/compress-image/`, not
`/ar/tools/compress-image/`) because the card and breadcrumb builders call `toolPath()`/`targetPath()`
directly. With one locale this is invisible and correct. `tests/locales.test.js` documents the behaviour, and
the audit now **errors** on a non-default-locale page that links to an unprefixed path — so the day a second
locale is added, `npm run audit:seo` fails loudly and names the page instead of shipping cross-locale links.
Making the link builders locale-aware is the work that changes; the URL layer underneath is done.

### robots.txt and `_headers`

- **`public/robots.txt` already existed and is generated** by `gen-sitemap.mjs` — it allows all crawlers and
  points at `${site.url}/sitemap.xml`, which is an absolute URL that only `content/site.json` knows. Hand-
  editing it would be overwritten on the next `npm run gen`, so this phase verified it instead of rewriting it
  (the audit checks the three lines that matter).
- **No `public/_headers` file was added, because nothing needs one.** COOP/COEP exist to enable
  `SharedArrayBuffer`, and a repository-wide search finds **zero** uses of `SharedArrayBuffer`, `Atomics` or
  `crossOriginIsolated` in `src/assets/js/`. The only plausible future need is `onnxruntime-web` multi-threaded
  inference in a background-removal phase, and `onnxruntime-web` is not installed. Writing COOP/COEP now would
  be a real cost for no current benefit: `Cross-Origin-Embedder-Policy: require-corp` blocks third-party
  subresources that do not opt in, and it would have to be re-verified against the worker and the dynamic
  `heic-to` import. Add it in the phase that actually introduces threading, with that phase's tests.

### Verification actually performed (Bun 1.4.2 standing in for the absent Node)

- `bun test tests/` → **157 pass, 1 fail**, the failure being the pre-existing `fflate` module resolution
  error from Phase 1 that `npm install` clears. Two new suites: `tests/seo.test.js` (10 tests) and
  `tests/locales.test.js` (6 tests), all passing.
- The full chain run **twice**: `build-pages` → `build-targets` → `gen-sitemap` → `gen-og`. Second pass reports
  `up to date` on all four (`gen-sitemap: 25 routes`, `gen-og: 25 cards, 51 files unchanged`). Byte-for-byte
  idempotent.
- Page diff against the snapshot taken before this phase's template work: **11 generated pages changed, each
  with exactly 3 removed lines** — `<html lang="en">` (now carries `dir`) and the two `<meta … image>` tags
  that pointed at the deleted `/og/default.svg`. Everything else on every page is additive: hreflang
  alternates, the JSON-LD block, and `og:image:width/height/alt`. No body copy and no control moved.
- All 25 PNGs are real 1200×630 PNGs (IHDR parsed), colour type 2 or 6, 50–60 KB each.
- `public/og/default.svg` is gone; nothing references it (`grep` over `src/`, `scripts/`, `tests/`).
- `pdf-lib` is referenced in exactly one place as a dynamic import inside `pdf.worker.js`; `engine-pdf.js`
  mentions it only in prose, so the planning logic stays pure and testable.
- Ad markup appears in **0** generated pages while `site.ads` is false, and the `.ad-slot` contract is present
  in `components.css` ready for the flag.
- 25 Vite entries, 25 sitemap URLs, 25 cards, 25 pages — all four lists derived from the same `siteRoutes()`.

### Acceptance checklist

| # | Criterion | Status |
|---|---|---|
| 1 | Lighthouse SEO = 100 on homepage and a tool page | **Not run — no browser on this host.** Substitute: `npm run audit:seo` → 0 errors across 25 pages, plus the procedure below |
| 2 | Structured data validates with no errors | **Structurally verified**, not by Google's tool: `validateGraph()` on every page's graph (by the audit and by the tests), which enforces required properties per type, absolute URL properties, 1..n breadcrumb positions, unique `@id`s and page-anchored nodes. Sample JSON-LD above for the Rich Results Test |
| 3 | OG images generate automatically and look correct for 3 samples | **Generated and structurally verified, not seen.** 25 PNGs exist at 1200×630; the three sampled cards (`home`, `tool-compress-image`, `guide-compress-image-to-100kb`) carry the correct title, eyebrow, description and footer text, extracted from the preview sheet |
| 4 | Report actual Lighthouse Performance numbers | **Not possible here.** Reported instead: render-blocking CSS 5.4 KB gzip, homepage JS 0.7 KB gzip, heaviest tool script 5.0 KB gzip, 0 above-fold images on home and the heaviest tool page, system fonts only, no ad box to shift layout |

### Open items (yours)

1. **Nine strings will be truncated in search results** — 6 `<title>`s over 60 characters (`convert-image` 67,
   `how-it-works` 66, `privacy` 65, `image-to-pdf` 62, `compress-image` 61, `crop-image-to-16-9` 61 — all
   including the ` | ImageTools` suffix) and 3 meta descriptions over 160 (`compress-image-to-200kb` 165,
   `convert-jpg-to-png` 163, `crop-image-to-square` 162). They are warnings, not errors, and were **not**
   silently edited: an SEO phase is the wrong place to rewrite tool copy. `npm run audit:seo --strict` fails on
   them if that is the policy you want.
2. **The `data-download` anchor** (`<a class="button" data-download download>`) has no `href` until a result
   exists, because the href is a blob URL. It lives inside a `hidden` result panel, so it is not a crawlable
   dead link as delivered, and the audit has exactly this one named exception. Replacing it with a `<button>`
   and a programmatically created anchor would remove the exception — it needs a browser to verify, so it is
   not in this phase.
3. **The origin is still `https://example.com`, and 25 cards now bake it into the images themselves.**
   `site.url` must be set before the last `npm run gen:og`, or every shared card advertises the placeholder.
4. **Run Lighthouse, then run it again.** There is nothing left to fix by reading HTML; the numbers need a
   browser. Procedure below.

### Manual test procedure (browser — yours to run)

1. `npm install && npm test` → expect **158 pass, 0 fail**. Then `npm run gen` twice: the second run must say
   *up to date* four times.
2. `npm run audit:seo` → expect `0 errors, 9 warnings`. Then `npm run audit:seo --verbose` to see all 25 URLs.
3. `npm run dev`, then on `/` view source: one `<script type="application/ld+json">` with WebSite +
   Organization, two `<link rel="alternate">` tags, and no `ad-slot` anywhere in the body.
4. Paste that JSON-LD into <https://search.google.com/test/rich-results>. Expect **Organization and
   BreadcrumbList recognised, no errors**, and a note that the page is not eligible for Software App (no
   rating — expected). Repeat for `/tools/compress-image/` and one `/targets/…` page.
5. Run Lighthouse (SEO + Performance) on `/` and `/tools/image-to-pdf/` — the homepage and the heaviest page.
   Record the four numbers; there is no baseline to compare against yet, so this run **is** the baseline.
6. Open `scripts/assets/og-preview.html` in a browser: 25 cards at true size. Confirm no text overflows its
   frame and nothing is clipped. Then check three PNGs directly — `public/og/home.png`,
   `public/og/tool-compress-image.png`, `public/og/guide-compress-image-to-100kb.png` — or paste a page URL
   into <https://cards-dev.twitter.com/validator> once deployed.
7. Add `"ar"` to `content/site.json` → `locales` with `"dir": "rtl"`, run `npm run gen`, and confirm the log
   shows `/ar/…` URLs being written while every English path is unchanged. Then run `npm run audit:seo` and
   watch it fail on the unprefixed internal links — that failure is the gap this phase documented, and
   **revert the locale afterwards**, since no Arabic copy exists.

### Files

**Created (9):** `scripts/audit-seo.mjs`, `scripts/lib/schema.mjs`, `scripts/lib/og-card.mjs`,
`tests/seo.test.js`, `tests/locales.test.js`, `scripts/assets/fonts/README.md` + the two `.ttf` files and the
font's `LICENSE.txt`.

**Rewritten (2):** `scripts/gen-og.mjs` (was a documented placeholder, now the satori + resvg pipeline),
`scripts/gen-sitemap.mjs` (route list now comes from `siteRoutes()`).

**Modified (15):** `scripts/lib/content.mjs` (locales, `siteRoutes`, per-locale loading, hreflang helpers),
`scripts/build-pages.mjs` and `scripts/build-targets.mjs` (locale loop, JSON-LD, alternates, ad slots),
`scripts/lib/tool-page.mjs` (OG URLs and dimensions, alternates, `adSlotsHtml`, JSON-LD-ready FAQ markup),
`scripts/lib/render.mjs`, `src/templates/{site,tool,tool-planned,target,page}.template.html`,
`src/assets/css/components.css` (the `.ad-slot` contract), `src/assets/js/workers/pdf.worker.js` (lazy
`pdf-lib`), `content/site.json` (locales, `ads: false`, `ogImage` off the deleted SVG), `package.json`
(`audit:seo`, devDependency pins), `tests/content.test.js` (site fixture now covers locales and `ads`).

**Generated (26 pages + 51 files):** 25 `index.html` plus `src/index.html`; `public/og/*.png|svg`,
`public/sitemap.xml`, `public/robots.txt`, `scripts/assets/og-preview.html`, and the four generated partials.

**Deleted (1):** `public/og/default.svg`.

### What Phase 6 should assume exists

- **`npm run gen` is the only way pages are produced**, and `npm run audit:seo` is the only thing that checks
  them. A new page kind must appear in `siteRoutes()` or the sitemap, the audit and the card set will miss it
  in the same way — which is why they all read that one function.
- **Every generated page carries**: `lang`/`dir`, canonical, hreflang alternates for every locale, a
  self-referential `og:url`, a 1200×630 `og:image` that exists on disk, and exactly one JSON-LD `@graph`.
- **Adding a page kind** means: an entry in the relevant content file, a branch in the generator, an
  `expectedTypes()` case in the audit, a card key in `og-card.mjs`, and a schema builder — four places, all
  checked by tests that fail loudly.
- **Adding a commercial surface** means flipping `site.ads` to `true`, which emits `<aside class="ad-slot …">`
  in positions whose height is already reserved; nothing else about the layout has to change.
- **`prebuild` now runs the audit**, so a page that loses its canonical fails `npm run build` rather than
  shipping.
- **Still unverified by anyone**: every browser-level claim in this repo — pica inside a worker, cropperjs 1.6.2
  against its own v2 API mismatch, the HEIC decoder fetching locally, and now the Lighthouse numbers. The
  static layer is as checked as it can get without a browser; the runtime layer is not.

---

## Phase 6 — PWA + Offline Support (completed)

### The two prerequisites, and why they came first

Nothing in this phase is testable until the tools can process a file, so the approved plan put two
fixes found by driving the app in a browser ahead of the PWA work. Both were real, both were on the
core path, and neither was reachable from a test:

1. **Comlink cannot carry a callback nested inside an options object.** `Comlink.proxy()` only tags a
   value with a module-local symbol, and `processArguments` serialises each *top-level* argument with a
   shallow loop — so `run(file, { onProgress })` shipped a plain function, failed structured cloning,
   and threw inside `postMessage`. Fixed by passing the callback as its own top-level argument
   (`run(file, options, Comlink.proxy(onProgress))`) in all four workers and all five tool scripts.
   Symptom before the fix: *every* tool silently fell back to its "this browser cannot do this" notice.
2. **`convertToBlob` on a context-less `OffscreenCanvas`.** The encoder probe built an
   `OffscreenCanvas` without a rendering context and asked it to encode; the result was
   `encodable: []`, so the convert tool refused to run. Fixed by getting a context first.

A third came out of the same pass: **reading `width`/`height` off an already-closed `ImageBitmap`
returns 0**, which showed up as `0×0 → 500×350` in the resize readout. The dimensions are now read
before the bitmap is closed.

### What shipped

- **`public/manifest.webmanifest`, generated** by `scripts/gen-manifest.mjs` from `content/site.json` —
  name, `short_name`, theme and background colour, `display: standalone`, `start_url: /`, one shortcut per
  live tool. Nothing about the app's identity is typed twice.
- **`public/icons/`, generated** by `scripts/gen-icons.mjs` from `scripts/assets/brand-icon.svg` through
  `scripts/lib/pwa.mjs`: 192 and 512 plain, 512 maskable (smaller glyph, no corner radius, so Android's
  crop cannot clip it), and a 180px `apple-touch-icon`. Real PNGs, IHDR-checked by the tests.
- **`dist/sw.js`, generated post-build** by `scripts/gen-sw.mjs` from `scripts/templates/sw.js`, plus
  `scripts/lib/dist.mjs` (the static-import graph walk, the PNG reader, the route finder).
- **`/pages/offline/`**, a real page with real copy (status `utility`: noindex, no nav, not in the
  sitemap), precached at install and used as the navigation fallback.
- **`src/assets/js/ui/pwa.js`**: one registration, one cache warm-up, one install banner, wired into the
  whole site by `ui/site.js`.
- **`scripts/audit-pwa.mjs`**: the substitute for a Lighthouse PWA score that no longer exists.
- **`tests/pwa.test.js`**: 10 tests, including the two that make the rest trustworthy — the manifest must
  be exactly what the content model generates, and the audit must *fail* when the worker is missing.

### Hand-rolled service worker, not Workbox

The trade, stated plainly: Workbox would give me precache manifests, expiry and a routing DSL for about
15 KB of runtime and a build-time dependency. This policy is four sentences long — shell precached at
install, navigations network-first with a cached fallback, `/assets/` cache-first because the content
hash is in the filename, everything else network-first — and the generator already knows the whole import
graph exactly. Owning ~90 lines was cheaper than owning a framework, and it means the bytes a visitor
downloads are ones I can account for line by line. The cost is that eviction and versioning are mine:
the shell is versioned, `pages` and `assets` are capped FIFO at 40 and 120 entries, and `/og/` (4.2 MB of
share images) is never cached at all.

### The offline test found a bug that passes every other check

**The first end-to-end offline check looked like a success and was a failure.** The cached document
rendered — status 200, correct HTML — and all eight of its chunks failed with `net::ERR_FAILED`. The
site came back with no CSS and no JavaScript, which is to say it did not work.

Cause, isolated by experiment (server killed, so every request to the origin genuinely refused):

| What the page does | Result |
| --- | --- |
| `<script>` (no `crossorigin`) | loads |
| `<script crossorigin>` | **fails** |
| `import()` (module) | **fails** |
| `<link crossorigin rel=stylesheet>` | **fails** |
| `<link>` (no `crossorigin`) | loads |
| `fetch()` (even CORS mode) | works |

**Cache Storage honours `Vary`.** A stored response only matches a request whose varying headers agree
with the request that stored it. The warm-up stores with a plain `fetch(url)`, which sends no `Origin`.
Every subresource these pages load is a CORS-mode request — the HTML Vite emits marks its scripts,
modulepreloads and stylesheets `crossorigin` — and a CORS-mode request *does* send one. Vite's dev and
preview servers set `Vary: Origin` (their default `cors: true`), so every offline subresource was a cache
miss. Fixed by passing `ignoreVary: true` on all five lookups: the URL already identifies the bytes — for
`/assets/` the content hash is in the name — so `Vary` describes nothing this cache needs to distinguish.

Two gates now prevent a repeat: `tests/pwa.test.js` fails if any generated lookup stops ignoring `Vary`,
and `scripts/audit-pwa.mjs` errors out the same way, so a deploy cannot ship it. Both were verified to
fail on purpose by stripping the option back out. The full account is in the header of
`scripts/templates/sw.js`, where the next person will read it.

### Offline evidence, exactly as obtained

The origin was genuinely unreachable, not emulated: the vite preview listener was stopped (nothing
listening on 4173, `curl` connection refused) while a supervising process kept the preview registration
alive. Then, with no server:

- `/tools/compress-image/` — visited earlier in the session — **reloaded complete and interactive**: one
  stylesheet (205 rules), the header, the footer, `data-year` filled by `site.js`, the tool UI wired and
  showing "Ready — drop an image, or a batch, to compress it".
- **It processed an image.** 1200×900 JPEG, 158 KB in, 103 KB out (−35%), dimensions and quality read
  out correctly. The worker script came from the cache, because there was no server to fetch it from.
- `/tools/convert-image/` — never visited — **showed the offline fallback**: "You are offline, and your
  images are still yours", `data-page-slug="offline"`, titled `Offline — ImageTools Still Works`, styled,
  and with no install banner on it (by design).

**What this is not:** airplane mode. The browser kept a working network interface the whole time — the
*origin* refused connections. For the service worker's purposes the two are the same thing, since both
surface as a rejected `fetch`, but the wording matters and the manual procedure below is the real
airplane-mode check.

### Acceptance checklist

| # | Criterion | Status |
| --- | --- | --- |
| 1 | First visit online, then airplane mode → the visited tool loads and processes a locally-selected image | **Met, by the strongest means available here** — origin stopped, page reloaded from cache, 158 KB → 103 KB. Airplane mode itself is unverified (no way to toggle a radio from this host); procedure below |
| 2 | Lighthouse PWA checks pass | **Not runnable, and no longer existent.** Lighthouse removed the PWA category in 12.0.0 (Chrome 126, April 2024) — *"As per Chrome's updated Installability Criteria, Lighthouse has removed the PWA category."* Substitute: `npm run audit:pwa` → **0 errors, 0 warnings** against Chrome's published install criteria plus this repo's own promises |
| 3 | Install banner appears once, respects dismissal | **Met.** In a clean session with a fresh prompt the banner does *not* build; it builds and shows on the first successful processing (verified through the real tool path, not a synthetic event); "Not now" writes `imagetools:install-dismissed=1`; in a *new* session that then processed another image with install still available, it stayed hidden |

The banner was verified with a synthetic `beforeinstallprompt`, because Chrome only fires the real one
after its own engagement heuristics (one interaction and thirty seconds on the page) — this is stated
rather than glossed over.

### Facts that shaped this phase

- **Chrome's install criteria no longer require a service worker.** HTTPS, a manifest with `name`,
  `short_name`, 192px and 512px icons, `start_url`, a valid `display`, and
  `prefer_related_applications` not true are the published list. The worker is what makes criterion 1
  possible; it is not what makes the app installable.
- **Registration is production-only** (`import.meta.env.PROD`). The dev server serves the source tree,
  where the built shell and hashed chunk names do not exist, so a worker registered there would promise
  URLs that are only valid in a build. The consequence is deliberate: offline can only be tested against
  a real build, which is what the procedure below does.
- **`/pages/offline/` is a `utility` status**, a new page status alongside `live` and `planned`. It keeps
  its existing rules — noindex, no nav entry, no sitemap entry, `priority <= 0.1` — so the content model,
  the sitemap and the SEO audit did not need a special case.

### Verification actually performed (Bun 1.4.2 standing in for the absent Node)

- `npm test` equivalent: **175 pass, 0 fail** across 14 files (10 of them new here).
- `scripts/audit-pwa.mjs`: **0 errors, 0 warnings**; and it errors when `dist/sw.js` is renamed away.
- `scripts/audit-seo.mjs`: **0 errors, 9 warnings** (all pre-existing length warnings on trust-page
  titles), so the new page kind did not disturb it.
- **All six generators idempotent**, each reporting `up to date` on a second run; `vite build` succeeds and
  is deterministic (identical asset hashes across two runs).
- **The offline path, end to end, with the origin stopped** — the reload, the processing run and the
  offline fallback all above.
- Preview server: `vite preview` on 4173, homepage and tool pages rendering, no console errors.

### Not verified here (yours to run)

Airplane mode as such; a real Chrome install prompt and the installed app window; the Application tab's
service-worker lifecycle view; the banner's appearance in a light theme (only dark was on screen); and
any Lighthouse score for the PWA surface, which no longer exists to report. Also still unverified from
earlier phases: crop's interactive drag, the HEIC decoder on a real HEIC, ZIP download of a multi-file
batch, and the one place a `targetSizeKB` search landed 3 KB over its 100 KB goal (103 KB at 95% quality,
reported without a note) — see the open item below.

### Files

**Created (10):** `scripts/lib/pwa.mjs`, `scripts/lib/dist.mjs`, `scripts/gen-manifest.mjs`,
`scripts/gen-icons.mjs`, `scripts/gen-sw.mjs`, `scripts/templates/sw.js`, `scripts/assets/brand-icon.svg`,
`src/assets/js/ui/pwa.js`, `src/pages/offline.html` (via `src/templates/pages/offline.html`),
`scripts/audit-pwa.mjs`, `tests/pwa.test.js`.

**Modified (20):** the four workers and all five tool scripts (the Comlink callback plus the
`imagetools:processed` signal), `src/assets/js/ui/site.js`, `src/partials/footer.html`,
`src/assets/css/{components,layout}.css`, `scripts/templates/sw.js` callers, all five page templates
(`{{pwaHead}}`), `scripts/lib/tool-page.mjs`, `scripts/build-pages.mjs`, `scripts/build-targets.mjs`,
`scripts/lib/content.mjs`, `scripts/lib/og-card.mjs`, `scripts/gen-icons.mjs`,
`scripts/gen-sw.mjs`, `content/site.json`, `content/pages.json`, `package.json`, `tests/*.test.js`
(five expectations updated where the route inventory legitimately grew), `PROGRESS_LOG.md`.

**Generated:** `public/manifest.webmanifest`, `public/icons/*` (4 PNGs), `dist/sw.js`, and `/pages/offline/
index.html`.

### Manual test procedure (browser — yours)

1. `npm run build && npm run preview` (with Node), then open `http://localhost:4173/`.
2. Visit `/tools/compress-image/` and process one image. The install banner appears at the bottom: it must
   *not* have appeared before the first image finished.
3. DevTools → Application → Service Workers: one worker, activated, "update on reload" off. Caches:
   `imagetools-shell-<hash>` (10 files), `imagetools-pages`, `imagetools-assets`. `Cache Storage →
   imagetools-assets` must contain the string `compress.worker-`.
4. Turn on airplane mode (or DevTools → Network → Offline). Reload the tool page: it must come back
   **styled and interactive**, not the offline page, and it must compress an image you pick from disk.
5. While still offline, type a page you have never opened, e.g. `/tools/crop-image/`: the offline fallback
   must appear, styled.
6. Reload any page: no install banner (dismissed in step 2 persists). In a fresh profile, dismiss it and
   check `localStorage['imagetools:install-dismissed'] === '1'`.
7. `npm run audit:pwa` and `npm test` — 0 errors, 175 passing.

### Open items (yours)

- **`content/site.json` still has three placeholders** (`https://example.com`, `hello@example.com`,
  `TO CONFIRM` in terms/contact). They now also set the manifest's `name` and the icons' colour, so they
  are visible in the installed app. The generators print them on every run.
- **A target-size search can land slightly over target** — 103 KB for a 100 KB goal, at 95% quality, with
  no "could not reach it" note. Phase 1's tolerance allows a small overshoot, so this may be by design,
  but a visitor asking for 100 KB and getting 103 KB deserves either a tighter search or the note. Not
  touched here: it is Phase 1 engine behaviour, outside this phase's scope.
- **Whether the service worker should precache a second route** if a visitor only ever visits one page.
  Current behaviour is deliberate (warm what you use), and the fallback page covers the rest.

### What Phase 7 should assume exists

- **Anything shipping to a browser needs `npm run build` first**: the manifest, the icons and the service
  worker are all generated into `public/` and `dist/`, not written by hand. `postbuild` runs `gen:sw` and
  then `audit:pwa`, so a worker that references a file the build did not produce fails the build.
- **`scripts/lib/dist.mjs` owns the built-output vocabulary** (bundle walk, route list, PNG size, file
  size). Anything that needs to reason about `dist/` should read it from there rather than re-walking.
- **`ui/pwa.js` exposes `PROCESSED_EVENT` (`imagetools:processed`) and `INSTALL_DISMISSED_KEY`.** A new
  tool dispatches `document.dispatchEvent(new Event(PROCESSED_EVENT))` once an image is done; that is the
  only integration the install banner needs.
- **`ignoreVary: true` on every cache lookup, gated in two places.** If a future phase adds a cache, or
  moves warm-up into the worker differently, that gate is what keeps offline working on a CORS-enabled
  host.
- **Offline is only testable against a build.** Any later engine that fetches WASM at runtime (background
  removal is the next candidate) needs its model files counted against the warm cap in `gen-sw.mjs`,
  because a runtime download is exactly what offline cannot do.

---

## Phase 7 — Background Removal + Magic Eraser (started, parked, not shipped)

Recorded here because Phase 8 ran next and the tree had to be returned to a consistent state first.

### What exists on disk

Sub-feature A's and B's *pure* layers are written: `core/raster.js`, `core/model-store.js`,
`core/onnx.js`, `core/mask-geometry.js`, `core/engine-segment.js`, `core/engine-inpaint.js`,
`workers/segment.worker.js`, `scripts/gen-ort.mjs` (generates the 13.6 MB ORT WASM from the pinned
`onnxruntime-web@1.30.0` dependency — never committed), and the `models` field plus an Apache-2.0/MIT
license allowlist in `scripts/lib/content.mjs`. The licence gate passed: verbatim Apache-2.0 texts and
file-level source URLs for both the segmentation model and LaMa are recorded with dates.

### What does not exist, and why the tool is parked

`src/templates/tools/remove-background.html` and `src/assets/js/tools/remove-background.js` were never
written, so the `remove-background` entry in `content/tools.json` pointed at a page that could not be
built. **This phase set it to `status: "planned"`**, which makes it render the planned-tool page
(noindex, "coming soon") instead of claiming a working tool. That single change is what took the suite
from **169 passing / 6 failing** back to green — route inventory, PWA head, service worker, OG cards,
sitemap and the SEO audit were all failing on the phantom tool page.

### Verification actually performed here

- `npm test`: **177 pass, 0 fail** at the start of this phase (up from 169/6).
- `scripts/audit-seo.mjs`: 0 errors.
- Model licences still unconfirmed: no U²-Net ONNX repo on Hugging Face commits a `LICENSE` file (all
ten checked carry a card tag only), and the Places2 site says "academic research and education
purposes", which does not read as the CC-BY 4.0 the phase text asserted. Both open questions are
recorded in `TRANSLATIONS.md`'s sibling notes and in the licence file itself.

**Do not treat Phase 7 as complete.** It is a half-built engine with a parked tool page, and
`content/tools.json` is the record of that.

---

## Phase 8 — Arabic Localization (i18n + RTL) (completed)

### The prerequisite, and why it came first

Phase 7 left the build broken (see above). Nothing in this phase could be verified against a failing
suite — and specifically, the SEO audit is the mechanism that enforces three of this phase's own
acceptance criteria — so parking `remove-background` as `planned` was step zero. It changed no
behaviour: the tool page was already broken, and "coming soon" is an honest description of it.

### What shipped

Arabic is now a **real second locale**, publishing 4 routes: `/ar/`, `/ar/tools/compress-image/`,
`/ar/tools/resize-image/`, `/ar/tools/convert-image/`. Everything else stays English-only and says so.

### The locale model: a publish list, not a merge

This is the decision the rest of the phase hangs on.

A naive second locale merges: base English content, Arabic overlay on top, anything missing falls
through to English. That is exactly how a site ends up with Arabic pages that are 60% English, and
nobody notices because the build is green.

So instead: **overlays are publish lists.** Listing a tool in `content/ar/tools.json` publishes its
*whole page*, and the loader fails the build if any translatable field is absent. `untranslatedFields()`
and `requireCompleteTranslation()` enforce it, including FAQ array length — a translation answers the
same questions in the same order, so a 4-item English FAQ with 2 Arabic items is an error, not a
partial success.

Two consequences that shaped everything else:

1. **`alternateLinks` became route-aware.** It used to emit an `ar` alternate for every route. Now it
   emits one only where Arabic actually publishes that route, so an English-only page such as
   `/tools/crop-image/` declares `en` and `x-default` and nothing else. An hreflang pair is a promise
   both pages exist; the old behaviour was 21 broken promises.
2. **A new audit rule fails any two pages sharing a `<title>`.** This is the backstop that makes the
   partial-translation failure *loud*: an Arabic page that copied its English title collides with its
   English twin and stops the build. It is the reason the publish-list gate cannot be quietly eroded.

### The string catalogue

`content/ui.json` holds 251 keys in two namespaces, and the split is load-bearing:

| Prefix | Where it goes | Example |
|---|---|---|
| `ui.` | `{{t.ui.…}}` tokens, read at **build** time into static markup | the "Compress all" button label |
| `js.` | an injected `#ui-strings` JSON block, read at **run** time | "Saved photo.jpg (96 KB)." |

`src/assets/js/ui/strings.js` reads the second half. Three deliberate choices, all commented in the
file: the catalogue is **inline rather than fetched** (a fetch is one more request that has to succeed
offline), a **missing key is loud** (warns and returns the key name itself, so a typo appears on screen),
and **`{name}` interpolation is never concatenation** (word order differs between languages, so a
sentence is one string per language rather than a translated filename glued between an English prefix
and suffix).

### Three real bugs, all found by running the thing rather than trusting the build

The first two were caught by tests written for this phase and the third by the live preview — and
**all three were live on the English site too**. This is the part worth reading.

**1. The run button relabelled itself to a raw key.** After a batch finished, `compress-image.js` set
`compressAllButton.textContent = t('js.compress.runAgain')` — and `js.compress.runAgain` was never in
the catalogue. `strings.js` returns the key name when a string is missing, so the button would have
read **`js.compress.runAgain`** on screen, in English, for every visitor who finished a batch. The same
bug existed in resize and convert (`js.resize.*`, `js.convert.*`): six keys referenced, zero defined.

Rather than add six runtime keys (which would duplicate the six `ui.*` labels that already existed —
the exact "same fact in two places" the Master Context forbids), the labels now travel **on the button**
as `data-label` / `data-label-done`, written from `content/ui.json` at build time. The script swaps two
attributes it was handed and never needs to know the language. `tests/i18n.test.js`'s key-wiring test
scans the source for every `js.`/`ui.` literal and fails on any reference with no catalogue entry — it
went from 99 referenced / 6 missing to 93 referenced / 0 missing (fewer references, because the six
were replaced by two attributes).

**2. Three engine error codes had no translated message.** `IMAGE_TOO_LARGE`, `UNSUPPORTED_FORMAT` and
`INVALID_ENCODE_RESULT` are thrown by `engine-compress.js`, `engine-convert.js` and `target-size.js`,
and all three flow through `localizeError()` — which falls back silently to the engine's English
sentence. So an Arabic visitor hitting a 30-megapixel image got English. All three now have entries.
The test enumerates codes by scanning `core/*.js` for thrown codes, so a new engine code cannot ship
untranslated.

**3. Every runtime string in the interface was rendering as a raw key name — in both languages.**
This is the worst bug in the phase, and it is the one that a green build, clean audits and 185 passing
tests all agreed was fine.

`runtimeStrings()` filtered the catalogue's `js.` keys into the page's `#ui-strings` block **and
stripped the `js.` prefix on the way in**, so the page was keyed `common.waiting`. All **164 call
sites** in the source pass the prefixed form — `t('js.common.waiting')`; there is not one bare call.
So no lookup could ever succeed, and `strings.js` did exactly what it is designed to do with a missing
key: return the key name. The live Arabic page showed `js.common.batchQueued` in its status line and
`js.common.download` on every download button; so did the English page.

It survived every gate because the whole thing is *internally consistent in the wrong direction*:

| Gate | Why it passed |
|---|---|
| The key-wiring test | It checked `EN_CATALOG[key]` — the **catalogue**, which is keyed `js.common.waiting` and therefore matched. The broken step is one stage *later* (catalogue → injected block) |
| The audits | They read generated HTML. The markup half of the catalogue is fine — it renders at build time through `{{t.ui.…}}` — and the runtime half is a `<script type="application/json">` blob nobody inspects |
| The Arabic-parity tests | The catalogue was complete and correct. It was the *injection* that was lossy |
| A quick manual look | The Arabic markup is visibly Arabic, so the page *looks* translated until something interactive happens |

Fixed at the source: `runtimeStrings()` now keeps the catalogue's own keys, so the key a script
writes is the key the catalogue defines. Not simply re-keyed the block to the stripped form, because
that would have left 164 call sites agreeing by coincidence with a transformation that has no
consumer.

The test was rewritten to assert against the **injected** block rather than the catalogue —
`injected[key] !== undefined` for every referenced key — and that change was then verified by
temporarily restoring the stripping version and confirming the test fails, naming
`src/assets/js/tools/compress-image.js` and the other files. A test that has never been seen to fail
is a guess.

### Two smaller leaks of the same kind

Both were found by *reading the Arabic page in the preview*, not by a build:

- **`acceptHint()` had an English default it always used.** It read
  `strings.template ?? '{formats} up to {size}'`, and `chromeStrings()` never supplied `template` — so
  the Arabic dropzone read **"JPEG وPNG وWebP up to 50 ميجابايت"**. The catalogue entry
  `ui.shell.acceptHint` ("{formats} حتى {size}") existed the whole time and nothing read it.
- **Arabic lists used a Latin comma.** `listPhrase()` joined with a hardcoded `', '`, so the Arabic
  hint read "JPEG, PNG أو WebP". The separator is now catalogue-driven (`ui.shell.listSeparator`:
  `,` / `،`) and the single space is added in code, because `validateUi()` trims every value and a
  separator carrying its own trailing space would silently lose it.

`tests/i18n.test.js` now asserts per-key that every string `chromeStrings()` must supply is present in
**both** languages — a helper key that is `undefined` is a helper running on its own English default,
which is exactly how both of these shipped.

### RTL: what mirrors, and the one thing that must not

`src/assets/css/rtl.css` (102 lines, linked only on `dir="rtl"` pages — enforced by the audit) handles
the 19 direction-sensitive declarations across the three stylesheets. Three parts of it are worth
knowing:

- **The compare-slider is pinned LTR, not mirrored.** Its `clip-path: inset(…)` is a physically
  anchored CSS property and its drag math (`event.clientX - rect.left`) is physical too. Mirroring the
  component makes the handle move *opposite* to the pointer — the classic RTL slider bug. It is
  isolated with `direction: ltr` and a comment saying why, rather than "fixed" into being wrong.
- **Numbers are bidi-isolated.** "1.2 MB → 96 KB (−96%)" is Latin digits and symbols inside an Arabic
  paragraph, where the bidi algorithm will reorder the pieces without `unicode-bidi: isolate`.
- **Filenames get `unicode-bidi: plaintext`**, because a filename is arbitrary text of unknown
  direction and its own first strong character should decide.

### hreflang

Reciprocal, and checked three ways rather than asserted. `scripts/audit-seo.mjs` verifies that every
declared alternate resolves to a real route, that the page it points at declares this page back, and
that the sitemap carries matching alternates for each `<url>` block. Verified on a real pair:
`/tools/compress-image/` declares `en`/`ar`/`x-default` and the canonical URL under test
re-declares it.

### The disclosure requirement, enforced

Every Arabic page carries a visible notice that the Arabic is machine-written and unreviewed. The audit
**fails the build** if a non-default-locale page has no `ui.chrome.translationNotice` string or does not
render it. `TRANSLATIONS.md` states the same thing at length, including a table separating what is
genuinely verified (key coverage, Arabic-not-English, Arabic punctuation) from what only a native
speaker can judge, and five specific decisions a reviewer may want to overturn — Western-vs-Eastern
numerals being the first.

### Acceptance checklist

| Criterion | Status |
|---|---|
| 1. Switching to Arabic flips direction cleanly; no broken UI in dropzone, slider, forms | **Done and verified in a live browser**, though a visual-design pass is still yours. `dir="rtl"` and `rtl.css` on every Arabic route, absent on every English one (audit-enforced). Verified interactively: the dropzone hint, the file rows, the progress line, the savings readout, the status line and the run button all render Arabic; the compare-slider stays `direction: ltr` with its clip at `inset(0 0 0 50%)` and its handle at 429 px of 857 px, i.e. the pointer and the handle agree under RTL |
| 2. hreflang valid and reciprocal, tested on at least one page pair | **Done.** `compress-image` verified in both directions; automated for every route by the SEO audit |
| 3. A clear list of translated vs English-only pages | **Done.** `TRANSLATIONS.md`, with the 4 Arabic routes tabulated against their English twins and every still-English surface listed |
| Flag machine-translated strings and say which need native review | **Done, and it is the headline of `TRANSLATIONS.md`.** All 249 Arabic strings were AI-written; none has been reviewed. Structural verification passed; naturalness is unverified |

### Verification actually performed (Bun 1.4.2 standing in for the absent Node)

- `npm test` equivalent: **186 pass, 0 fail** across 15 files — 9 of them new here in
  `tests/i18n.test.js`, plus updated expectations in `locales`, `content` and `seo`.
- **Both audits clean:** `audit-seo` 31 pages / 0 errors (9 pre-existing length warnings);
  `audit-pwa` 0 errors, 0 warnings.
- **All seven generators idempotent**, each reporting `up to date` on a second run; `vite build`
  succeeds and emits `dist/ar/**` including the three Arabic tool pages.
- **English output is unchanged by the tokenisation**, checked by content assertion rather than a diff
  (this workspace has no git): the tokenised target-page sentences render byte-for-byte as the
  hard-coded ones did above them.
- **The negative gates were exercised, not just written.** The key-wiring test failed on six real
  missing keys before the fix; the error-code test failed on three real missing codes; the SEO audit's
  publish-list rules fail when an Arabic page is un-published; and the rewritten injected-key
  assertion was confirmed to fail against the old `runtimeStrings()` before being kept.
- **Live in the preview**, Arabic and English, end to end: a synthetic 900×600 JPEG batch dropped into
  `/ar/tools/compress-image/` compressed **145 KB → 93 KB (−36%)** and `/tools/compress-image/`
  **158 KB → 106 KB (−33.4%)**, with the button relabelling to "إعادة الضغط" / "Re-run all" and no
  raw `js.*` key anywhere in the visible text of either page.

### Not verified here (yours to run)

Arabic rendering in a real browser — this host has no Arabic font stack installed, so glyph shaping,
line breaking and the `isolate`/`plaintext` bidi behaviour are the highest-value things to eyeball.
Also not run: a screen-reader pass over the RTL pages, and Lighthouse on an Arabic page. See
`TRANSLATIONS.md` for the two known unfinished items (Arabic OG cards need an Arabic-capable font —
IBM Plex Sans has no Arabic glyphs; the offline fallback page is English-only).

### Files

**Created (14):** `content/ui.json`, `content/ar/{ui,site,tools,pages,targets}.json`,
`src/partials/ar/{header,footer}.html`, `src/templates/ar/home.html`, `src/assets/css/rtl.css`,
`src/assets/js/ui/strings.js`, `tests/i18n.test.js`, `TRANSLATIONS.md`.

**Modified (~25):** `scripts/lib/{content,render,tool-page,schema}.mjs` (publish-list loaders,
route-aware `alternateLinks`, `chromeStrings` moved into the shared lib, localised OG tags),
`scripts/{build-pages,build-targets,audit-seo}.mjs`, `content/{site,tools}.json` (the `ar` locale and
the parked Phase 7 tool), all five page templates plus the three live tool fragments,
`src/assets/js/ui/{progress,pwa,compare-slider,dropzone}.js`, all three live tool scripts,
`src/templates/target.template.html`, `tests/{locales,content,seo,pwa}.test.js`.

**Generated:** `src/ar/index.html`, `src/ar/tools/*/index.html`, `src/partials/ar/nav-*.html`,
`src/partials/ar/tool-grid.html`, and the English `src/**/index.html` that the earlier phases left stale.

### Manual test procedure (browser — yours)

1. `npm run build && npm run preview`, then open `http://localhost:4173/ar/`.
2. Direction: the page must read right-to-left — nav on the right, the lang switcher mirrored, text
   aligned right. Nothing should overlap.
3. Use the language switcher (top of the page, beside the header): English ⇄ العربية. On an
   **English-only** page such as `/tools/crop-image/` the Arabic entry must say it goes to the
   homepage — hover it for the tooltip.
4. On `/ar/tools/compress-image/`, drop an image and compress it. The dropzone hint, the progress
   label, the savings readout and the "download" button must all be Arabic, and the size readout
   (`1.2 MB → 96 KB (−96%)`) must read in the right order, not reversed.
5. The before/after slider must drag the way you move the pointer. It is deliberately pinned LTR: the
   handle follows your finger, even though the page is RTL.
6. Finish a batch of 2+ images: the run button must relabel to Arabic ("إعادة تشغيل الكل"), **not** to
   `js.compress.runAgain`.
7. Trigger an error — try a `.txt` file renamed to `.jpg`, or an enormous image: the message must be
   Arabic, not English. `IMAGE_TOO_LARGE` is the one that used to leak English.
8. View source on `/ar/tools/compress-image/` and confirm: `<html lang="ar" dir="rtl">`, a `/ar/`
   canonical, three `alternate` links, and `rtl.css` in the head but **not** on any English page.

### Open items (yours)

- **Native-speaker review of all 249 Arabic strings.** This is the gate on going live with `/ar/`.
  `TRANSLATIONS.md` lists the five judgement calls to check first. The tool copy is a working draft, not
  final copy.
- **An Arabic-capable font for OG cards**, if Arabic social previews matter. IBM Plex Sans Arabic is
  OFL-licensed, so it is likely viable — but adding a font is a licensing decision, and this phase did
  not take it. Arabic cards currently generate at the right paths with an unrenderable title.
- **`content/tools.json` still says `remove-background: planned`.** Unparking it is Phase 7's remaining
  work, not this phase's.
- The three pre-existing placeholders (`https://example.com`, `hello@example.com`, `TO CONFIRM`) are
  unchanged, and every Arabic page inherits them.

### What Phase 9 should assume exists

- **Adding a locale is a content change, not a code change.** Drop `content/<code>/`, add the locale to
  `content/site.json`, and the generators write the pages, sitemap entries, alternates and OG cards.
  `content/ar/` is the worked example.
- **`content/ui.json` is the only place a sentence may live.** Not in a template, not in a script. The
  key-wiring test fails on a reference with no entry in either direction, and the Arabic-parity tests
  fail if the two catalogues drift.
- **`scripts/lib/content.mjs` owns the locale vocabulary**: `loadX(locale)`, `localePath`,
  `alternateLinks`, `localePublishes`, `markupStrings`, `runtimeStrings`. Anything that renders a page
  reads its strings from there.
- **Labels that change at runtime belong on the element**, as `data-label`/`data-label-done`. That
  pattern replaced six broken runtime lookups and is the one to copy.
- **A catalogue key is the same string everywhere**: the catalogue key, the key a script writes, and
  the key in the injected `#ui-strings` block. `runtimeStrings()` performs no transformation, and
  `tests/i18n.test.js` asserts against the *injected* block rather than the catalogue, because the
  difference between those two is where 164 broken lookups hid.
- **A new error code needs a `js.error.<CODE>` entry**, or it will surface in English on an Arabic page.
  `tests/i18n.test.js` fails if it is missing.
- **Do not give a shared markup helper an English default.** `acceptHint()`'
  `strings.template ?? '…up to…'` leaked English onto an Arabic page for a whole phase. Helpers take
  their sentences from `chromeStrings()`, and the test asserts every one of those keys is non-empty in
  every locale.
- **The preview is the gate that builds cannot replace.** Three of this phase's bugs were invisible to
  a green test suite, both audits and 31 generated pages; all three were obvious within a minute of
  loading `/ar/tools/compress-image/` and doing something.
- **None of this is reviewed copy.** Anything built on `/ar/` inherits an unreviewed translation.

---

## Phase 9 — Build repair + mobile UX (Gates 1 and 2 done, Gate 3 pending)

### Gate 1 — the build was already repaired, and that is all it needed

The phase asked for one field: `remove-background` in `content/tools.json` flipped from `status: "live"`
back to `"planned"`, because its template and tool script were never written. **That flip was already on
disk**, made at the start of the Phase 8 work for the same reason it was asked for here: a red suite cannot
gate anything, and `build-pages` could not run with a `live` entry that had no template. Nothing was
re-flipped, because nothing needed flipping.

Re-verified rather than assumed: `bun test` → **186 pass, 0 fail**; all seven generators report
`files unchanged` / `up to date` on a second pass; no Phase 7 file (template, script, engine) was written;
the `remove-background` entry itself is untouched.

### The finding that shaped Gate 2: a closed `<details>` cannot be opened by CSS

The plan for the four secondary sections was "`<details>`, closed by default, expanded by CSS on
desktop, no JS". The first half works and the second half is **impossible in every engine shipped today**,
not a matter of writing the rule better:

- `::details-content` — the only author-reachable handle on a disclosure's content box — exists from
  Chrome 131. This host's webview is Chrome 130, and Safari only exposed it in 18.4.
- Before that, the UA hides a closed disclosure's content inside an anonymous box. Specificity does not
  matter because the box is unreachable, and the author sheet cannot outrank it.

Six candidates were tested in the live preview and every one failed: a direct-child `display: block`, the
same with `!important`, `content-visibility: visible`, `display: grid` on the `<details>`, `overflow:
visible`, `::slotted`, and `all: revert` on the children. Each rendered a heading with an empty 46px box
beneath it — a desktop regression, not a cosmetic difference.

**The approved fix, and the reason the markup looks the way it does:** the `<details>` carries only the
`<summary>` and nothing else; its job is to hold the `open` state and the disclosure semantics. The prose
sits beside it in `.secondary-body`, revealed on a phone by one rule over ordinary siblings
(`details[open] + .secondary-body { display: block }`) and laid out unconditionally on a wide screen.
No JavaScript, no engine sniffing, and identical behaviour with scripting disabled. The `<section>` keeps
the class the block always had, so `.tool-notes ul` and friends still match.

### Second real defect, found in the same pass and fixed in scope

`[hidden]` did nothing inside a tool panel. An author `display` rule outranks the UA sheet's
`[hidden] { display: none }` whatever the specificity, so the result panel, the progress region and the
batch list were laid out from page load — visible before a file was chosen, with `—` placeholders and a
Download button, which came to 1307px of the 375px-wide resting page. One rule now covers the whole panel rather than ten
selectors, so a region added later cannot forget it. It also moved the criteria this phase measures: the
resting English page went from 3260px to 1878px at 375px wide.

### Gate 2 — measured, at a 375px layout width

Real numbers from the registered preview, not adjectives. The webview cannot be resized and iframes wedge
it (they wedge it even on a light parent page, with the load-handler race ruled out), so the 375px state was
produced by pinning the document's layout width; the one viewport-relative rule on the page
(`.tool-header h1`'s `clamp(…, 4vw, …)`) was corrected to its 375px value rather than left to resolve
against the 717px window.

| What | Measured |
|---|---|
| Sticky bar, files queued | `data-sticky="on"`, `position: fixed`, height 47px, bottom == `innerHeight`; body `padding-bottom` 56px (= 44 + space-3 12 + `env(safe-area-inset-bottom)` 0) |
| Sticky bar, at rest | `data-sticky="off"`, `position: static` — desktop keeps the inline button, and the attribute is set from the queue's existing `renderBatch` hook, no new module |
| `viewport-fit=cover` | present on all 31 generated pages; 11 of those differ from before by exactly that one line |
| Four sections, phone | all four `<details>` without `open`, body `display: none`; 61px each, 244px total, against 2264px expanded — 2020px of prose folded away |
| Four sections, desktop | bodies laid out (700-wide emulation: 548/557/342/557px; at 1440: 240/342/294/317px), headings visible, summary inert (`cursor: auto`, `pointer-events: none`) |
| Touch targets at 375px | 28 measured across panel, drop zone and nav; **zero below 44px**, smallest 44px; theme and menu toggles both 44×44 |
| One primary action | exactly one visible while queued ("Compress all"); ZIP hidden with 1 file and visible with 3; Cancel only mid-run; Download / Start over only after a result |
| Arabic RTL | `dir="rtl"`, bar spans the viewport, sections collapsed with Arabic summaries, document width 375 with no overflow |
| `bun test` / `audit:seo` / `audit:pwa` | 186 pass 0 fail · 0 errors, 9 pre-existing warnings · 0 errors |

**Two criteria fail, and they are the same problem twice.** The drop zone's bottom edge is at 754px in the
resting state, against a 667px window (criterion 3's drop-zone clause), and the page above the sections is
1241px against 1000.5px (criterion 4's second clause). Neither is caused by the sections: above them sit a
64px header, a 44px breadcrumb, a 261px hero (**60px `<h1>` + a 189px intro paragraph**) and a 692px panel.
Delete the intro and the drop zone's bottom lands at 565px, inside the window with 102px to spare.

That intro is in `src/templates/tool.template.html`, which is **not** in this phase's allowed file list, and
wrapping it in a disclosure needs a new catalogue key in both `content/ui.json` and `content/ar/ui.json` —
which would also mean an Arabic string written by me and flagged as unreviewed. So it is a decision, not an
implementation detail, and it is the one thing Gate 2 leaves open.

### Criterion 7: the desktop diff, stated exactly

31 generated pages differ from the pre-change snapshot. Normalised for whitespace:

- **11 pages** (the homepage, `ar/index.html`, the six trust pages, the parked `remove-background` page)
  differ by **one line**: the viewport meta gaining `viewport-fit=cover`.
- **5 pages** carry sticky-bar markup: `tools/compress-image`, its Arabic twin, and its three target pages,
  which embed the same panel.
- The remaining 20 differ by the section restructure. **This is larger than the "`<details>` wrapping"
criterion 7 allows** — it adds a `<section>` wrapper and a `.secondary-body` div per section and re-indents
the prose two spaces. That deviation was put to a vote in this phase and approved explicitly, for the reason
above: the literal wrapping renders as an empty heading on a desktop.

CSS weight: the appended block in `components.css` is **7,640 bytes raw / 3,020 gzipped** as source; the
shipped shared chunk grew by **+2,007 raw / +375 gzipped** after minification (measured by rebuilding with
the block removed and diffing the emitted `site-*.css`). `layout.css` was not touched: the mobile work
needed no shared spacing change, so the file listed in the plan stayed as it was.

### Files changed

`content/tools.json` (verified, not re-edited) · `src/templates/tools/compress-image.html` ·
`scripts/lib/tool-page.mjs` · `scripts/build-pages.mjs` (the shared emitter moved into the lib) ·
`src/assets/css/components.css` · `src/assets/js/tools/compress-image.js` · `PROGRESS_LOG.md`.
Nothing was created: no new npm package (deps still 8 + 3), no new JS module, no new page (25 pages,
31 routes, as before).

### What Gate 3 has to do

The four other tool templates still open with a plain `<section class="tool-notes">`, so their "How this
works" block is neither a disclosure nor collapsible. Rolling the pattern means, per tool:
`resize-image`, `convert-image`, `crop-image`, `image-to-pdf` — convert that block to
`<section class="secondary-section tool-notes"><details><summary><h2>…</h2></summary></details><div class="secondary-body">…</div></section>`,
put `data-primary-action data-sticky="off"` on the primary button (**"Build PDF"** for image-to-pdf, whose
action is not queue-driven), and toggle `data-sticky` from the existing `renderBatch` callback. The
generated sections (guides, FAQ, related tools) need nothing: they come from the shared emitter and are
already done on every tool and target page.

### Gate 3 — the intro, the other four tools, and the two criteria Gate 2 left failing

Two jobs in one pass: fold the hero's intro away on a phone (the 189px that kept the drop zone below the
fold), and roll the whole pattern to `resize-image`, `convert-image`, `crop-image` and `image-to-pdf`.

**The intro is the same disclosure, in the hero.** `<div class="intro-disclosure" data-collapsible>` wraps
`<details><summary>What this tool does</summary></details>` and the paragraph, which now carries the
`disclosure-body` class. On a phone the row is 44px and the paragraph is hidden; on a desktop the
`<details>` itself is hidden (`display: none`) and the paragraph sits exactly where it always has — measured:
the summary row reports a height of 0, and the paragraph's top is 280 against the `<h1>`'s bottom edge of 268,
the same 12px gap as before. The label is a new catalogue key, `ui.tool.introSummary`, in both languages.

**That change is what closes criterion 3.** Drop-zone bottom edge at 375px wide: **609px**, against a 667px
window — inside the fold with 58px to spare. It was 754px. The page above the sections came down with it,
from 1241px to 1096px.

**Both target pages and parked pages got it too.** `target.template.html` and `tool-planned.template.html`
carry the same hero, so `/targets/compress-image-to-100kb/` and the parked `remove-background` page would
otherwise have kept the problem. Measured on the target page: drop-zone bottom 637px, still inside the fold.

**The mechanics hook moved from the section class to `[data-collapsible]`**, and the body class is now
`disclosure-body` rather than `secondary-body`. The rules were scoped to `.secondary-section` when the four
editorial sections were the only disclosures on the page; the hero needs the same three rules and none of the
section's rule line or padding, so the CSS now hooks the marker both wrappers already carry. `.secondary-section`
kept its job — the border and padding that read as a section break.

### The bug this pass found, and the test that now catches it

The intro shipped for one build as `<p class="tool-intro">` with **no body class**, so nothing hid it: the page
got *taller* (drop-zone bottom 798px instead of 754px) and the only thing that noticed was the live measurement.
A green suite, both audits and 190 generated pages all agreed the build was fine.

`tests/markup.test.js` is the guard, four tests over every generated tool and target page in every locale that
publishes it:

1. the hero's intro is a disclosure with a summary and a disclosure body;
2. the number of `<details><summary>` disclosures equals the number of `disclosure-body` elements — the
   assertion that fails with "5 disclosures but 4 disclosure bodies" when a body loses its class;
3. no disclosure ships `open`, and every live page has **exactly one** `data-primary-action`, carrying
   `data-sticky="off"` in the static markup;
4. a parked page promises no action at all, because there is none to take.

Checked the way the Phase 8 tests were: the intro class was removed from a generated page on purpose, the test
failed naming the page and the reason, and regenerating the page made it pass.

### The four tools, and what each one's sticky bar reads

| Tool | Primary action | What the bar follows |
|---|---|---|
| `resize-image` | "Resize all" | the queue, via the same `renderBatch` callback as compress |
| `convert-image` | "Convert all" | the queue, likewise |
| `crop-image` | "Apply crop" | the crop toolbar — one image at a time, so there is no batch state to read. Off while a crop is running, on again when the result is up, off on "Start over" |
| `image-to-pdf` | "Build PDF" | the order list. Off while the PDF is being built, because Cancel is the action that matters then |

Both queue-driven tools needed a second fix to go with it: they hid the batch row for a single file
(`state.total < 2`), which on a phone hides the row the sticky bar lives in — the same defect compress had.
They now use the narrow-aware test, plus the `matchMedia` listener, so a rotated phone re-renders the row.

Measured at 375px wide, every one of the five tool pages: exactly one visible primary action, the bar `fixed`
at the bottom, body `padding-bottom` 56px while it shows and 0px when it does not, all four sections collapsed
with `display: none` bodies, intro folded. Drop-zone bottom edge by tool: compress **609**, resize **609**,
convert **609**, image-to-pdf **579**, and the target page **637** — all inside a 667px window.

**Crop's state machine was walked in full**, because it is the one that does not come from a queue: image
loaded → `on` (toolbar visible) → "Apply crop" clicked → `off` with the progress region up → finished → `on`
with the result and the comparison slider ("Cropped to 1020×680 at 2 KB") → "Start over" → `off`, and the body
padding released back to 0px. image-to-pdf likewise: queued → `on`, building → `off` with Cancel visible,
finished ("PDF ready — 2 pages, 20 KB") → `on` again.

### Criterion 4's second clause is still out of reach, and here is the arithmetic

The four sections collapse as required (244px total against 2264px expanded). "The page height above them is
≤ 1.5× viewport height" is **1096px against 1000.5px** — 96px over, down from 1241px. Above the sections sit:
a 64px header, a 44px breadcrumb, a 60px `<h1>`, the 44px intro row, and a 692px panel whose own parts are a
220px drop zone, 340px of form controls and a 42px status line. Closing the last 96px means changing spacing
or typography, which the brief rules out, so it is left measured rather than fudged.

### Files changed in this pass

`src/templates/tool.template.html` · `src/templates/target.template.html` · `src/templates/tool-planned.template.html` ·
the four remaining `src/templates/tools/*.html` · `src/assets/css/components.css` · `src/assets/js/tools/{resize-image,convert-image,crop-image,image-to-pdf}.js` ·
`src/assets/js/tools/compress-image.js` (comment only: the `MOBILE_QUERY` constant is no longer the only copy) ·
`scripts/lib/tool-page.mjs` · `content/ui.json` · `content/ar/ui.json` · `TRANSLATIONS.md` ·
**`tests/markup.test.js` (new)** · `PROGRESS_LOG.md`.

No new npm package (deps still 8 + 3), no new page (25 pages, 31 routes), and no new browser-side JS module —
the sticky wiring is four small additions inside scripts that already existed, and `MOBILE_QUERY` is stated
once per tool rather than imported, because a shared module for one string would be a dependency between five
files that otherwise share nothing but their worker boundary.

CSS weight, for the whole phase rather than this pass alone: the appended block in `components.css` is now
**8,583 bytes raw / 3,346 gzipped** as source (up 943 / 326 from Gate 2), and the shipped shared chunk grew by
**+2,048 raw / +402 gzipped** over its pre-phase size. Measured by rebuilding with the block removed and
diffing the emitted `site-*.css`; the file was restored byte-identical, sha `4e4ab5cf…` verified.

`bun test` **190 pass / 0 fail** · `audit:seo` **0 errors** (9 pre-existing warnings) · `audit:pwa` **0 errors** ·
all seven generators idempotent on a second pass · `vite build` clean.

---

## Photo Enhance tool — briefed as "Phase 9 — One-Click Photo Enhance" (complete)

**Numbering note:** this log already used "Phase 9" for the build repair + mobile UX pass above, and the
brief for the enhancement tool used the same number. Keeping both titles distinct is cheaper than
renumbering twenty-two sections, so this one is named after the tool.

A seventh live tool: `/tools/enhance-photo/` — one histogram correction followed by five fixed styles,
with live previews rendered from the visitor's own photo and one intensity slider. No new dependency.

### The pipeline, and why it is two stages rather than one

**Stage A — histogram correction.** Per channel: sort the 0–255 population, take the 0.4th and 99.6th
percentiles as the working black and white points, then stretch that span across the full range. Three
details are load-bearing:

- **The percentile clip is what makes it safe.** An absolute min/max would let one specular highlight or
  one dead pixel define the range, and the photo would come back flat.
- **The gain is capped (`MAX_GAIN`) and floored (`MIN_GAIN`).** Amplifying a nearly black frame mostly
  amplifies its noise; measuring told us the cap has to bite early — see the underexposure row below,
  where all three channels hit the 6.00× ceiling and the correction is honest about landing at 198
  rather than 255.
- **A channel already spanning the range is left alone** (`MIN_GAIN` guard). Without it a full-range
  channel still got a pointless 1.008× stretch. That bug was in the first draft of the engine and was
  found by the engine's own test, not by eye.

Stretching the three channels independently is what removes a colour cast — that is the whole
auto-white-balance mechanism, and the cast row below shows it taking a +94.9 channel imbalance down to
+12.6 with no colour-specific code anywhere.

**Stage B — five styles on top of Stage A's output**, expressed as named primitives applied in one fixed
order (brightness → contrast → s-curve → temperature → saturate/grayscale → split-tone → luminance
unsharp mask), which is the order a colourist works in. The four presets whose look `ctx.filter` can
express are graded through the GPU; the exact numbers are in `ENHANCE_PRESETS` and repeated here because
the brief asked for them rather than for adjectives:

| Preset | brightness | contrast | saturate | temperature | other |
|---|---|---|---|---|---|
| Natural Pop | 1.02 | 1.08 | 1.10 | — | sharpen 0.35 @ r1 |
| Vivid | 1.02 | 1.22 | 1.40 | +0.10 | sharpen 0.50 @ r1 |
| Warm / Golden | 1.07 | 0.95 | 1.06 | +0.40 | split-tone: shadows +8/+2/−10, highlights +18/+8/−22 |
| Cool / Moody | 0.98 | 1.18 | 0.85 | −0.35 | split-tone: shadows −10/−2/+18, highlights −6/+2/+12 |
| Classic B&W | 0.99 | 1.06 | grayscale 1 | — | s-curve 0.5 |

Warm and Cool are the two that need per-pixel work: a colour-temperature shift and a shadow/highlight
split are the two adjustments `ctx.filter` cannot express, so those run through the manual
`getImageData`/`putImageData` path. Sharpening is a luminance-only unsharp mask in all five, because
sharpening the colour channels turns noise into coloured speckle.

### Acceptance checklist, item by item

**1. Stage A alone visibly improving three photos with different lighting faults — done, measured.**
Each photo is the same mid-tone scene put through a different fault, so the correction has something
honest to fix. Numbers are the 0.4/99.6 percentile points of each channel, sampled from the actual
result image in the browser:

| Fault | Before (R/G/B black → white, mean luminance) | After | Worker's own readout |
|---|---|---|---|
| Underexposed (scene ×0.18) | 8/8/6 → 42/41/37, mean **26.8** | 1/1/3 → 198/198/186, mean **112.8** | gains **6.00× / 6.00× / 6.00×** (capped), black 9/8/6, white 42/41/37 |
| Overexposed (140 + 0.45×) | 162/160/152 → 249/243/229, mean **206.8** | 2/2/3 → 255/255/255, mean **144.0** | gains 2.93× / 3.07× / 3.31×, black 162/160/152, white 249/243/229 |
| Colour cast (R×1.18, G×0.72, B×0.66) | channel means 179/108/84 (**R−B +94.9**), white 255/164/133 | 157/146/144 (**R−B +12.6**), white 255/255/255 | gains 1.29× / 1.93× / 2.28× |

The overexposed frame is the clearest of the three: a hazy, milky image with its black point at 162
comes back with true blacks at 2 and a neutral white. Two honest notes: the underexposed frame lands at
198 rather than 255 because the 6× cap bites (by design — the alternative is amplifying its noise), and
the overexposed frame's cast goes from +13.5 to **−6.7**, i.e. slightly over-corrected toward cool,
because the per-channel stretch equalises the extremes rather than the means. Both are visible to the
eye and both are the price of a colour-blind histogram stretch; a tint pass would fix the second and is
not in this phase.

**2. Five presets visually distinct across photos — done, measured on two very different photos.**
Signature per preset, as mean RGB and mean saturation of the actual rendered preview:

| Preset | Landscape 2400×1600 (mean RGB / sat) | Low-key portrait 1600×2000 |
|---|---|---|
| Natural Pop | 130/107/89 · **0.518** | 92/90/94 · **0.433** |
| Vivid | 139/103/77 · **0.663** | 89/86/89 · **0.586** |
| Warm / Golden | 152/119/80 · 0.560 | 112/101/82 · 0.520 |
| Cool / Moody | 107/100/103 · 0.388 | 75/83/103 · 0.500 |
| Classic B&W | 104/104/104 · **0.000** | 84/84/84 · **0.000** |

The two tables share one ordering — Vivid most saturated, Cool the only one where blue leads warm, B&W
exactly neutral — on a bright landscape and a near-black portrait. That is the property worth having:
the presets are reading the image's own histogram, not one reference scene. Full-size before/after for
two styles on two photos:

- **Landscape:** natural 119.3/91.3/83.8 (sat 0.384) → vivid 131.4/80.5/67.1 (sat **0.609**).
- **Portrait:** original 99/88/74 (sat 0.331) → natural 92/90/93 (sat 0.420, the R>B cast neutralised by
  Stage A) → warm 112/101/81 (sat 0.528, R−B +31).

**3. Thumbnails rendered from the actual uploaded photo — done, proven three ways.** They are `blob:`
URLs produced by the worker from the decoded photo (not static assets); their per-preset pixel
signatures match the preset definitions rather than each other; and they change when the photo changes —
two different uploads yield the two columns in the table above. Visually confirmed in a screenshot at
375px: the dropped landscape's own gradients render inside each chip.

**4. Intensity blends smoothly, no banding — done, measured two ways.** Sweeping vivid from 0% to 100%
(mean saturation of the result image): **0.384 → 0.444 → 0.501 → 0.557 → 0.609**, even steps of
+0.060/+0.057/+0.056/+0.052, monotone, with 0% reproducing the auto-corrected frame exactly. Distinct
tonal levels in the sampled region rise 166 → 181 → 192 → 201 → 208, so nothing is being quantised
away. The dedicated banding probe uses a deliberately smooth 2400px ramp and measures run lengths along
a scanline, where posterisation shows up as longer flat runs: mean run **5.53 → 5.19 → 4.86 → 4.01 →
3.43 px** and distinct levels **113 → 123 → 132 → 141 → 159** as intensity rises. Blending never
collapses a tonal step; it separates them.

**5. Worker + batch, UI never frozen — done, measured.** Five 3000px photos, enhanced in one batch with
the main thread instrumented: **296 animation frames** sampled over 1.81s, median frame gap **6.1ms**,
90th percentile **6.1ms**, worst **19.8ms**, **zero** frames over 33.4ms (no dropped frame at 60Hz) and
zero over 100ms — while two worker jobs were running. Per-row status advanced `queued → running → done`
with the batch list updating live, and the batch finished at "5 images · 5 ready" with
"Download all as ZIP" appearing. Processing is inside `enhance.worker.js` over comlink, exactly the
Phase 1 shape.

**6. No new external library — confirmed.** `package.json` is untouched (mtime 01:29, the Phase 7
commit); dependencies remain the same eight (`browser-image-compression`, `comlink`, `cropperjs`,
`fflate`, `heic-to`, `onnxruntime-web`, `pdf-lib`, `pica`) plus `satori`, `@resvg/resvg-js`, `vite`.
Encoding is `OffscreenCanvas.convertToBlob`; every adjustment is canvas 2D or arithmetic on a
`Uint8ClampedArray` written for this tool.

### The optional Advanced section: built, and flagged as such

The brief marked three extra sliders as optional. They are in, behind a closed `<details>` labelled
"Advanced (optional)": **brightness 50–150%, contrast 50–150%, warmth −50…+50**, plus a Reset. Choosing a
style never requires them, they never alter the main flow, and they are applied on top of whichever
style is selected. This is the only piece of the phase that was optional, and it is the piece most
likely to want a second look — a curves/HSL editor was explicitly out of scope and this is not that.

### A second mobile defect, found while verifying this tool and fixed

The mobile touch-target block sets `display: inline-flex` on `.tool-panel .button` to centre a tall
label. That selector ties on specificity with the `[hidden] { display: none }` guard in the same file —
a class and an attribute both count as one — so source order decided, and **every button a script had
hidden was laid out anyway at ≤767px**: "Download all as ZIP" on a single file, Cancel before a run,
Download and Retry before a result. The earlier `[hidden]` fix handled regions (which are `div`s); the
buttons were the half it could not reach. Measured before the fix on the enhance page: 10 of 10 hidden
buttons laid out with real 47px boxes. After: `display: none` on all of them, and the guard is now
`:not([hidden])` on the offending rule with the tie documented at both ends. This affected all five tool
pages on a phone, not just the new one, and it is the kind of defect only a live measurement finds.

### One claim in the user-facing copy was corrected rather than left flattering

The worker's fallback path (manual per-pixel grading where `ctx.filter` is unavailable) was described to
the visitor as using "the same maths". Measured against each other on the same input, the two paths
agree to **within 3–4 code values**, not exactly — the GPU filter and the manual arithmetic are close
but not identical. The string now says the two paths land within a few code values of each other and
that the manual path takes a little longer. Copy that overstates a measurement is worse than copy that
admits the gap.

### Files

**Created (5):** `src/assets/js/core/engine-enhance.js` · `src/assets/js/workers/enhance.worker.js` ·
`src/assets/js/tools/enhance-photo.js` · `src/templates/tools/enhance-photo.html` ·
`tests/engine-enhance.test.js`

**Modified (7):** `content/tools.json` (the `enhance-photo` entry, `status: "live"`) · `content/ui.json`
and `content/ar/ui.json` (61 new strings) · `src/assets/css/components.css` (preset row, chips,
thumbnails, intensity and advanced sliders, the mobile range-input target and the `:not([hidden])`
guard) · `tests/locales.test.js` (the count pins move to seven tools) · `TRANSLATIONS.md` ·
`PROGRESS_LOG.md`

**CSS weight:** the new `Photo enhance` section of `components.css` — the preset row, the five chips,
the thumbnails, the intensity row and the advanced disclosure — is **5,513 bytes raw / 2,019 gzipped**
(lines 1263–1473). The only other stylesheet changes are inside the existing mobile block: one selector
in the touch-target list (`.tool-panel .range-input`) and the `:not([hidden])` guard.

Nothing under `content/targets.json`, no generator, no other tool, and no page outside the two generated
from `tools.json`. The counts move with it — **32 generated pages** (1 homepage + 6 site pages + 14
targets + 7 tool pages + 4 Arabic routes), of which `gen-sitemap` publishes **30 routes** (it withholds
`/pages/offline/` and the parked `/tools/remove-background/`). The new tool appears in the homepage
grid, the nav, the sitemap and its own OG card without any of them being hand-edited, because all four
read `tools.json`.

### Manual test procedure

1. `npm run gen && npm run build`, then open `/tools/enhance-photo/`.
2. Drop **one dark photo**. The panel reports the gains, black points and white points it measured; the
   before/after slider shows the lift, and five thumbnails render from that photo within a second or two.
3. Press **Auto enhance**. The style readout changes to "Auto enhance", the intensity slider goes
   disabled, and the result is the correction with no style on it.
4. Tap **Vivid**, then drag **Intensity** from 100% to 0% and back. The result should move smoothly and
   at 0% should match step 3's output exactly.
5. Open **Advanced (optional)**, move Warmth to +30, and confirm the result warms without the slider
   asserting itself anywhere else. Press **Reset**.
6. Drop **five photos at once**. Rows advance `queued → running → done` one after another; the page stays
   scrollable throughout; "Download all as ZIP" appears once a second file is queued and one has
   finished. Download the ZIP and confirm five images, in order.
7. Press **Start over**, then drop a photo with **no** correction needed (a well-exposed daylight frame).
   The status should say the correction found nothing worth doing rather than inventing a stretch.
8. On a phone-width window: the drop zone and the action bar are both reachable without scrolling, the
   five chips scroll horizontally inside their row, and nothing that should be hidden (ZIP with one file,
   Cancel before a run, Download before a result) is on screen.

### Two things left open, deliberately

1. **"Does it look professional on a portrait?" is measured toward, not judged.** I can show the five
   preset signatures are distinct and stable across two very different photos, and that the numbers move
   in the direction each preset name promises. I cannot tell you whether Warm / Golden on a real skin
   tone reads as golden or as orange — that needs your eye on real photographs, which the repo has none
   of (the test photos are generated in-browser precisely because no photo fixtures are committed).
2. **The ZIP button appears once a second file is queued and one has finished**, not once two have
   finished. That is the rule Phase 1 established and all four queue tools share
   (`state.total < 2 || state.succeeded === 0`), stated here because the mobile brief's wording was
   "only when >1 file is done" and this is looser than that wording. Changing it means changing the rule
   for compress, resize and convert as well, so it is raised rather than quietly adjusted.

### What the next phase should assume exists

- Seven live tools, and `content/tools.json` is the only place their metadata lives.
- The `[data-primary-action]` + `data-sticky` contract for the mobile action bar, and
  `[data-collapsible]` + `.disclosure-body` for anything that folds on a phone. Both are CSS-only and
  both now have a regression test (`tests/markup.test.js`) that fails if a generated tool page renders
  without them.
- `engine-enhance.js` exposes both stages separately (`autoCorrect` and `grade`), so a future
  "auto-enhance on upload" feature can call Stage A alone — which is what the standalone Auto button
  already does.
- The 61 Arabic strings for this tool exist but render nowhere, because the tool is not translated.
  See `TRANSLATIONS.md` for why that is a smaller gap than it looks and what to check first if it is
  translated later. **(Superseded: Gate A translated the tool, so all 61 now render — see the Gate A
  entry below.)**

---

## Full Arabic localization — Gate A: glossary, six static pages, three tools (complete)

**Status: complete and verified by execution.** Scope: `content/ar/glossary.json`; six Arabic bodies at
`src/templates/ar/pages/*.html`; `content/ar/pages.json`; the crop-image and image-to-pdf panels (their
copy was still literal English in the template and their JS had no catalogue keys at all); three more
entries in `content/ar/tools.json`; and the English-unchanged proof the owner asked for. Gates B–E
(14 target pages, the RTL test, sitemap alternates, documentation) are **not started**, per the owner's
instruction not to proceed without approval.

### Acceptance checklist

| # | Criterion | Result |
|---|---|---|
| 1 | `bun test` green | **215 pass / 0 fail** (was 214; +1 new hardcoded-label test) |
| 2 | `audit:seo` and `audit:pwa` exit 0 | **0 errors** each. `audit:seo` reports 41 pages / 2 locales and 10 warnings: the 9 pre-existing English ones plus **one new** — the Arabic privacy title is 61 characters (English privacy is 65 and was already warned) |
| 3 | Every page has an `/ar/` twin | **13 of 28 English routes** (46%). The brief's "all 32 pages" double-counted the 4 Arabic routes that already existed and predated Parts B–E; the owner confirmed the corrected target of 28 Arabic routes total |
| 4 | `dir="rtl"` + `lang="ar"` on every Arabic page | **13/13**, checked against the built `dist/` tree |
| 5 | Reciprocal hreflang | **13/13 pairs** — each Arabic page declares `en`/`ar`/`x-default` and the English twin links back |
| 6 | 250-word gate for Arabic targets | **Not applicable at this gate** — `content/ar/targets.json` is still `[]` and `build-targets.mjs` refuses non-default locales by design (Gate B) |
| 7 | No English sentence on an Arabic page | **10 of 13 pages clean. 3 contain exactly one Latin string: `hello@example.com`**, the site-wide placeholder contact address that also appears in English and is still awaiting a real one. Technical vocabulary (WebP, JPEG, `px`, Web Worker…) is glossary-approved |
| 8 | The two empty Arabic content files are populated | `content/ar/pages.json` **6 entries** (`targets.json` stays empty until Gate B) |
| 9 | Arabic disclosure on every Arabic page | **13/13** (`ui.chrome.translationNotice`, enforced by a build audit) |
| 10 | No new npm dependency | **Confirmed** — `package.json` untouched |

### Did the English change? Mostly no, and here is the exact accounting

A page-by-page comparison against a copy of the pre-gate `dist/` tree, with chunk hashes normalised:

| Result | Pages |
|---|---|
| Visible text byte-identical to the pre-gate build | **27 of 28** |
| Visible text changed | 1 — `/pages/contact/` (below) |
| Differ only by added catalogue keys inside the embedded `#ui-strings` block | 19 |
| Differ by catalogue keys **and** a new direct Arabic twin link in the language switcher | 8 |
| Differ by catalogue keys, twin link **and** the entry-chunk shape | 1 |

No English page is byte-identical, and claiming otherwise would be false: **every page embeds the whole
string catalogue**, which grew by 81 keys (+4,982 bytes of block on `/pages/about/`, page 25,281 →
30,279 bytes; +1,348 gzipped). Every pre-existing key still exists with the same English value.

1. **The one visible English change — a fix.** `/pages/contact/` shipped its repository notice as
   *escaped* markup, so visitors read `<span class="page-placeholder">…</span>` as literal text. Moving
   the sentence into the catalogue made it real markup; the notice now renders as intended. Words
   unchanged, tags no longer visible. The `TO CONFIRM` marker survives inside the styled span, in both
   languages («يجب التأكيد»).
2. The crop/PDF dropzone hint now carries a literal `—` instead of `&mdash;` (identical rendering).
3. `/tools/enhance-photo/` loads its six modules as six `<script type="module">` tags instead of one
   entry plus `modulepreload` links — matching the other six tools. Re-verified live afterwards.

### Three English strings found on Arabic pages, and the two checks added for them

All three are the same failure mode: a string that never consults the catalogue, so no existing test
could see it.

| Where | What visitors saw | Fixed to | How it was found |
|---|---|---|---|
| `src/assets/js/ui/site.js` | The mobile menu button announced **"Close menu"** on *every* Arabic page | `js.chrome.menuOpen`/`js.chrome.menuClose` — English values unchanged, so English pages are unaffected; Arabic announces «افتح القائمة»/«أغلق القائمة» | Reading a live Arabic page's accessibility tree |
| `src/assets/js/tools/convert-image.js` | **"Waiting"** in every queued batch row | `js.common.waiting` → «في الانتظار» | Dropping two files on `/ar/tools/convert-image/` |
| `src/assets/js/tools/crop-image.js` | **"Download 4 KB"** on the primary button after a crop | `js.common.downloadSize` → «تنزيل 4 KB» — the key four other tools already used | Cropping a photo on `/ar/tools/crop-image/` |

Both `Waiting` and `Download 4 KB` sat in the two tool panels this gate tokenised: the static half was
converted to catalogue keys and verified, while a label composed at run time from a literal was not.
New guards, both of which would have caught them:

1. `tests/i18n.test.js` → *"no user-visible label is written into the page as an English literal"*: fails
   on a quoted literal assigned to `textContent`/`placeholder`/`title`/`aria-label`. **Proven effective**
   by reintroducing `'Waiting'` and watching it fail, then restoring it.
2. `verify-gate-a-ar.mjs` (scratch, outside the repo) now scans `aria-label`, `title`, `alt` and
   `placeholder` in addition to visible text — that is what found `Close menu`.

### Files changed in Gate A

Created: `content/ar/glossary.json`, `content/ar/pages.json`, and six Arabic page bodies —
`src/templates/ar/pages/{about,contact,how-it-works,offline,privacy,terms}.html`. No test file was
created: the new guard is a test added inside the existing `tests/i18n.test.js`.

Modified: `content/ar/tools.json`, `content/ar/ui.json`, `content/ui.json`, `content/ar/glossary.json`
(px correction), `src/templates/tools/{crop-image,image-to-pdf}.html`,
`src/templates/{page.template.html,pages/contact.html}`, `src/assets/js/tools/{crop-image,
convert-image,image-to-pdf}.js`, `src/assets/js/ui/site.js`, `scripts/build-pages.mjs`,
`scripts/lib/tool-page.mjs`, `tests/i18n.test.js`, `tests/locales.test.js`, `TRANSLATIONS.md`, this file.

Generated (by `npm run gen`, not hand-edited): 13 pages under `src/ar/`, the English pages, `public/`
Sitemap, 41 OG cards, `dist/`, `dist/sw.js`.

### Key decisions this gate

1. **Six Arabic bodies exist as new files; no English template was touched.** `src/templates/pages/*.html`
   carry zero catalogue tokens — they are 100% hardcoded English prose — so the Arabic bodies are
   hand-written twins rather than a refactor of the English ones. `readLocaleTemplate()` already fails
   the build if a page publishes in a locale with no body, so the "half-translated page" hole was
   already closed by construction; this gate verified rather than implemented that.
2. **The glossary is data, not a document.** `content/ar/glossary.json` (103 terms + 29 keep-English
   exceptions) is the single place a term is decided, so a reviewer can change one word and know every
   page follows.
3. **`px` is not transliterated.** Where the English label says "(px)", Arabic says "(px)"; «بكسل» is
   reserved for the spelled-out word "pixels". Five strings in `content/ar/ui.json` were corrected for
   this ("(بكسل)" → "(px)") after the owner's glossary ruling.
4. **`remove-background` is not translated** (owner decision): its English page is `status:"planned"`,
   `noindex`, out of the sitemap, and its engine is parked. `build-pages` prints exactly that when it
   skips the entry, so the decision is visible in the build output rather than implicit.
5. **The legal pages' `TO CONFIRM` marker is translated, not hidden** (owner decision): the Arabic
   terms and contact pages carry «يجب التأكيد» in the same visible placeholder span as English.

### Manual test procedure

1. `npm run gen && npm run build`, then open `/ar/pages/about/`.
2. Confirm the page is right-to-left, the nav and footer are Arabic, and the grey notice under the
   article says this translation is machine-made and unreviewed.
3. Open `/ar/tools/crop-image/`, drop a photo, press **طبّق القص**. The status line and the primary
   button must both read Arabic — the button should say «تنزيل …» and never "Download".
4. Open `/ar/tools/image-to-pdf/`, drop two photos: the rows must read «في الانتظار», the reorder buttons
   must have Arabic accessible names, and **ابنِ ملف PDF** must build a downloadable PDF.
5. Open `/ar/tools/enhance-photo/`, drop a photo: five style chips and five thumbnails generated from
   *your* photo.
6. On a phone-width window, open the mobile menu: the announced label must be «افتح القائمة» / «أغلق القائمة»,
   not "Open menu".
7. Open `/pages/contact/`: the "The code" paragraph must show a styled grey notice, *not* visible
   `<span class="page-placeholder">` text.

### What Gate B should assume exists

- 13 Arabic routes, each with a reciprocal `en`/`ar`/`x-default` alternate set and a language switcher
  entry that is generated, never hand-written.
- `content/ar/pages.json` is now a working publish list, so the pattern for "a page in a second locale"
  is settled: overlay JSON + a body file under `src/templates/ar/pages/`.
- The catalogue is at **452 keys in parity**; the embedded block on every page carries all of them, so
  the next 14 translated target pages will add weight to *every* page rather than only their own. If that
  matters, the fix is to embed only the keys a page's own scripts reference — deliberately not done here.
- Target pages still cannot render in a non-default locale: `build-targets.mjs` throws and names the
  template sentences plus `describeDefaultOption()` as the prerequisites. That is Gate B's first job.
- `audit:seo` must stay at 0 errors; Arabic titles longer than 60 characters produce warnings, and one
  already does.
