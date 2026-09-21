# REPORT — three goals, on `overnight/20260921`

**Verification URL: `http://localhost:4317`** (Vite preview of the rebuilt `dist/`).
Branch `overnight/20260921`, from `main` @ `e948858`. Nothing merged, nothing deployed.

---

## The diagnosis — why the owner saw nothing change

It was not caching. **Every change lived only on the unmerged branch `overnight/20260921`, and
41 of those files were not even committed** — they sat in the working tree. The live site at
`browserimageeditor.online` serves `main`, which has none of it:

| Check | `main` (deployed) | `overnight/20260921` |
|---|---|---|
| `src/partials/ar/nav-tools.html` | الضغط · المقاس · التحويل · القص · صور إلى PDF · التحسين | خفّة · أبعاد · تبديل · إطار · مستند · إشراق |
| `src/assets/js/ui/studio.js` | does not exist | exists, shared by all six tools |
| Live site `/ar/tools/compress-image/` (HTTP 200) | old labels, no studio markup | — |

The owner looked at the live site; the work had never left the branch. The service worker does
precache the shell, but `/assets/*` are content-hashed and navigations are network-first, so a
deploy would have shown. Full detail in **DIAGNOSIS.md**.

**The font was a separate matter** — see Goal 1.

---

## Goal 1 — Thmanyah: NOT SHIPPED. The licence forbids it.

I extracted the ZIP and read `LICENSE.pdf` in full (5 pages) myself rather than trusting the
summary. The text is unambiguous:

- **Permitted**: "Embed the Font Software in websites … **only as part of a compiled, packaged,
  or obfuscated product**."
- **Prohibited**: "Redistribute, share, upload, **host, or make the Font Software available for
  download on any website**"; "allow end users … to extract, download … **independently as font
  files, including through web embedding**"; "Modify … or reverse-engineer"; "Create Derivative
  Works" — which bars subsetting.
- Governed by the laws of the Kingdom of Saudi Arabia, disputes in the courts of Riyadh.

A self-hosted WOFF2 under `/fonts` fails all three: it is hosted for public download, the site
is not a compiled/obfuscated product, and this is an open-source repo whose public build makes
extraction certain. Per the brief's own step-1 stop condition, **Goal 1 is stopped. No font file
enters the repo; the ZIP was never committed; only the final files were ever read, from a temp
folder outside the project.**

**What landed instead** — the architecture a permitted font drops into, so the day written
permission arrives shipping it is a diff and not a project:

- `--font-body` and `--font-display` defined once in `base.css` (text cut for body, display cut
  for headings), Arabic-capable faces throughout the chain.
- Form controls now inherit `letter-spacing` as well as font (`font` alone does not cover it).
- `rtl.css` no longer hard-codes a stack that overrides the token — it reorders the *same* chain
  Arabic-first, which was the one real "second file overrides everything" defect.
- The debug overlay moved to the mono token and back above the 12px floor.
- A commented `@font-face` drop-in slot marks exactly where a licensed family goes.

**To unblock (owner picks one):** obtain a written web-embedding exception from
`ask@thmanyah.com` — the address the licence itself names — permitting self-hosting and
subsetting, and commit it beside the files. Or approve a swap to an OFL Arabic family (Cairo,
Tajawal, IBM Plex Sans Arabic, Readex Pro, Noto Naskh Arabic). Either is then a short, safe
change. Recorded in **BLOCKED.md B1**.

### Font measurement table — 14 pages × 6 probes, on the served site

| Surface | Arabic pages (7) | English pages (7) |
|---|---|---|
| body, nav `a`, button, input | `"SF Arabic", "Noto Sans Arabic", "Noto Naskh Arabic", "Geeza Pro", "Segoe UI", Tahoma, -apple-system, BlinkMacSystemFont, "SF Pro Text", …` | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Arabic", "Segoe UI", Tahoma, "Noto Sans Arabic", …` |
| h1 (display cut) | same chain with **`SF Pro Display`** | same chain with **`SF Pro Display`** |
| `document.fonts.status` | `loaded` | `loaded` |
| **External requests** | **0** | **0** |
| **Font requests** | **0** | **0** |

Arabic pages lead with `SF Arabic`; English pages lead with the system defaults; headings take
the display cut in both. There is no `@font-face` anywhere in the repo, by licence — so
`document.fonts.check()` against a Thmanyah face is not applicable, and I have not reported a
number for it.

---

## Goal 2 — one modern naming set, from one source

Final set, applied to nav, mobile sheet, home cards and related-tool cards:

| Tool | Short name | Subtitle |
|---|---|---|
| compress | خفّة | صغّر حجم صورك |
| resize | أبعاد | غيّر العرض والارتفاع |
| convert | تبديل | حوّل بين JPEG وPNG وWebP |
| crop | إطار | اقتصّ الصورة وأعد تكوينها |
| image-to-pdf | مستند | اجمع صورك في ملف PDF |
| enhance | إشراق | أنعش الإضاءة والألوان |

`مستند` keeps a Latin format name out of an Arabic nav label. **One source**: `navLabel` and
`cardName`/`cardSubtitle` in `content/ar/tools.json` + the EN mirror — the build generates every
nav, sheet and card from those, so they cannot drift. Descriptive copy is untouched: `name`,
`title`, `description`, `h1`, `keywords`, `faq` still carry ضغط الصور وتغيير مقاس الصور وما
follows, so breadcrumbs, JSON-LD and search engines are unchanged.

**Proof:** a label-level grep over 70 files extracts every short label in nav/card/footer/
breadcrumb markup and compares it against the old set — **0 violations**. The old flat labels
(الضغط · المقاس · التحويل · القص · صور إلى PDF · التحسين) appear now only inside descriptive
phrases where they are substrings of longer copy, which is correct and expected.

Screenshots: `screenshots/header-ar-1440.png`, `screenshots/mobile-menu-ar-390.png`,
`screenshots/home-ar-390.png`.

---

## Goal 3 — one shared upload surface, empty state is the surface and nothing else

The Studio Shell was already on all six tools and both locales — but the **inspector was visible
before any picture existed**: eleven chips, a slider and steppers for an image that was not
there. That is exactly the "reads like a form" failure the brief rules out, and it is what the
owner would still have seen. The fix is two CSS declarations and no new markup:

```css
.tool-panel:has(.dropzone:not(.has-file)) { grid-template-columns: minmax(0, 1fr); }
.tool-panel:has(.dropzone:not(.has-file)) .studio-inspector { display: none; }
```

`:has()` resolves at first paint, so the inspector never flashes; `has-file` is toggled by the
shared dropzone the moment a file is accepted or reset.

The surface gained the copy and doors the brief names: a breathing icon, أفلت صورك هنا, أو
الصقها من الحافظة, a تصفّح الصور primary, the quiet formats-and-privacy lines, and a
**جرّب بصورة تجريبية** button that draws a picture on a canvas in the tab and hands it to the
input the dropzone already owns — the same path a real drag takes, so no tool's logic is
touched and nothing is fetched.

### Two-state verification — all six tools, 1440 and 390

| Tool | Empty: drop width | Empty: inspector | Empty: controls | Loaded: inspector | Loaded: controls |
|---|---|---|---|---|---|
| compress | 1158 / 305 | hidden | 0 chips, 0 sliders | shown | 11 chips + 1 slider |
| resize | 1158 / 305 | hidden | 0 / 0 | shown | 14 chips |
| convert | 1158 / 305 | hidden | 0 / 0 | shown | 3 chips |
| crop | 1158 / 305 | hidden | 0 / 0 | shown | 3 chips |
| pdf | 1158 / 305 | hidden | 0 / 0 | shown | 9 chips |
| enhance | 1158 / 305 | hidden | 0 / 0 | shown | 4 sliders |

**0 failures.** The only dashed border anywhere on any tool page is cropperjs's own
rule-of-thirds guides inside `.cropper-container` — the crop tool's selection UI, not the dashed
upload box. Native `<select>`s remain in the DOM as the value holders (the tool scripts own
them) and are `aria-hidden` + `tabindex="-1"` while a chip radiogroup presents them.

### Rules checked and passing
Body ≥ 16px (17px), no text below 12px, tap targets ≥ 44px at 390px, `prefers-reduced-motion`
zeroes every animation, no horizontal scrollbar at 1280/800/390, contrast AA on the new
elements, zero requests leaving the origin.

### Screenshots (30 files in `/screenshots/`)
`empty-<tool>-{1440,390}.png`, `loaded-<tool>-{1440,390}.png`, `home-ar-{1440,390}.png`,
`header-ar-1440.png`, `mobile-menu-ar-390.png`, `theme-{dark,light}-compress-1440.png`.

---

## Four defects found by the verification round, fixed and re-measured

| Defect | Symptom | Fix | Re-measured |
|---|---|---|---|
| **resize wiring** | `[data-width]` matched the "original" chip first (it carries the same pair as a selector reference), so custom sizes were inert and 1080×566 became 566×566 | scoped to `input[data-width]` | preset → 1080/566, output 1080×566 |
| **convert slider** | template wrote `class="compareSlider"` where CSS targets `.compare-slider`; the panes went absolute against the viewport and covered the page, chips unclickable | one class | container 240px, chip hittable |
| **chip contrast** | white on `#007aff` = 4.02:1 light / 3.65:1 dark — fails 1.4.3 | solid ramp | **5.61:1** light / **4.81:1** dark |
| **input has no name after load** | every label child is `display:none` under `.has-file`, and the `.dropzone-more` the CSS reveals existed only in the CSS | restored to all six templates + own `aria-label` | name is تصفّح الصور |

Also: chip radiogroups resolve `aria-labelledby`; `#main` takes `tabindex="-1"` so the skip link
moves focus; below 360px the header overflowed by 5px and `overflow-x:clip` silently ate the
menu toggle.

---

## All tools still process and download — 30 runs, 0 errors

| Tool | small 400×300 | large 2400×1600 | portrait 900×1600 | transparent PNG | batch ×4 |
|---|---|---|---|---|---|
| compress | PASS · −65.5% | PASS · −84.4% | PASS · −82% | alpha preserved | ZIP enabled |
| resize | PASS | PASS | PASS (preset 1080×566 confirmed) | alpha preserved | ZIP enabled |
| convert | PASS | PASS | PASS | alpha preserved | ZIP enabled |
| crop | PASS | PASS | PASS | alpha preserved | N/A — single by design |
| image-to-pdf | PASS · 2 pg | PASS · 2 pg | PASS · 2 pg | alpha preserved via `/SMask` | **4 pages** |
| enhance | PASS | PASS | PASS | alpha flattened (pre-existing) | ZIP enabled |

Every run: `[data-result]` visible, a `blob:` download href, a populated size label, **0
`pageerror` events, 0 console errors, 0 non-localhost requests.**

Truth notes: five real Web Workers are in use — `compress.worker.js`, `convert.worker.js`
(shared by crop), `enhance.worker.js`, `pdf.worker.js`, `resize.worker.js` — via Comlink, with a
main-thread fallback if a worker cannot load. The enhance worker is canvas-based and loads no
model; `onnxruntime-web` and `segment.worker.js` belong to the planned remove-background tool,
which is not live and is out of scope. Enhance flattens alpha by design (pre-existing, not a
regression) and keeps the source format. The PDF page count was verified by inflating the
compressed object streams, not by byte-matching.

---

## Commits on `overnight/20260921`

```
7b50c43 Goal 3: one shared upload surface — empty state is the surface and nothing else
60259cc Goal 1+2: type tokens that a licensed font drops into, and the final short tool names
f351e2c Studio Shell on compress: chips, sliders, glass drop surface (reference impl)   [prior]
66cafc8 Copy: final Arabic naming and voice applied site-wide                            [prior]
```

A follow-up commit carries the four audit fixes, the regenerated pages, and the 30 screenshots.
`npm test` 246/246, `npm run build` green, `audit:seo` 0 errors, `audit:pwa` 0 errors.

---

## How the owner sees it

1. **Locally, right now:** `npm run build && npx vite preview` → **http://localhost:4317**
   (already running). Browse `/ar/` and the six `/ar/tools/*/` pages. Hard-refresh once if a
   service worker from an earlier visit is cached — the precache version bumps on every build.
2. **On the live site:** requires merging `overnight/20260921` into `main` and deploying. That
   was **not done** — per the brief's hard rules. The branch is pushed only if authentication
   already works; verify with `git push -u origin overnight/20260921 --dry-run`.

## Not verified on a real iPhone — manual checks

- iOS Safari press-and-hold **Save to Photos** (the prior run fixed the three CSS declarations
  that removed it from the sheet; verified by code path and unit test, not on a device).
- The RTL/LTR switch and the Arabic type rendering on an actual iOS device — the Arabic-first
  stack leads with `SF Arabic`, which is present on iOS but not on Windows, so a Windows
  browser renders the *fallback* face, not the primary. The chain is correct; the glyphs are not
  the owner's machine's best unless viewed on Apple hardware or an Android with Noto installed.
- WebKit-specific compositing of the glass blur and the sticky primary-action bar at 390px.
- The `?debug=1` overlay is the owner's on-device confirmation path for the save chain.

## Honest limitations of this strike

- **I cannot view images.** The 30 screenshots are produced as proof artifacts, but every claim
  about them above is backed by a numeric measurement (geometry, computed styles, contrast
  ratios, request logs), not by my having looked at them. A human should eyeball
  `screenshots/empty-compress-1440.png` and `loaded-crop-390.png` for the final aesthetic call.
- Goal 1 is **not satisfied as requested** — the font the owner named cannot lawfully be
  shipped, and I have said so rather than substituting a different family unilaterally.
