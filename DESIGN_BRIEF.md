# DESIGN_BRIEF — Browser Image Editor redesign

Source of truth for every agent. Read before editing. Conflict = this file wins.

## 0. Product
"محرر الصور في المتصفح" — 100% client-side image tools, Arabic (RTL) primary, English (LTR)
secondary. Tools (identical names everywhere): ضغط الصور، تغيير مقاس الصور، تحويل صيغة الصور،
قص الصور، تحويل الصور إلى PDF، تحسين الصور. No uploads, no signup, no limits but the device.

## 1. Architecture (do not break)
- Pages are GENERATED: `content/*.json` + `src/templates/*` + `src/partials/*` →
  `scripts/build-pages.mjs` / `build-targets.mjs` → `src/index.html`, `src/tools/*`,
  `src/targets/*`, `src/pages/*`, and the `/ar/*` mirrors. Regenerate with `npm run gen`.
- `<!--#include partials/x.html-->` is expanded by the Vite plugin (dev + build, identical).
- CSS is 4 files: `base.css` (tokens + resets) → `layout.css` (header/footer/chrome) →
  `components.css` (every component) → `rtl.css` (RTL delta, Arabic pages only).
- i18n: `content/ui.json` (+ `content/ar/ui.json`). `ui.*` → markup via `{{t.ui.*}}`;
  `js.*` → `#ui-strings` JSON read at runtime by `ui/strings.js`. Add a key to BOTH files.
- Tests (`npm test`) lock: `data-collapsible`/`disclosure-body`/`<details><summary>` shape,
  exactly one `data-primary-action` per live tool page (resting `data-sticky="off"`),
  `PALETTE` in `scripts/lib/og-card.mjs` == base.css dark tokens, i18n completeness.
- Hard hooks (see Repo Map §4): every `data-*` and id the tool scripts query. Keep them all.
- ONE breakpoint: 768px (tool JS hardcodes `(max-width: 767px)`). No other breakpoint.

## 2. Design language — "Studio Glass"
iOS-caliber, restrained, one accent. Not a copy of the reference: it hides its header and
reinvents chrome; we keep our shared header/nav/language switch on every page, always.

Tokens (base.css `:root`, light) — accent `--blue:#007AFF`; dark `#0A84FF`.
bg `#F2F2F7`/`#000`; surface `#FFFFFF`/`#1C1C1E`; stage well `#1C1C1E`/`#0A0A0B` (stays dark in
both themes); separators/fills as alpha grays. Text: `--label:#000`/`#FFF`; secondary
`rgba(60,60,67,.62)` light / `rgba(235,235,245,.6)` dark; tertiary same as secondary is fine —
**no token may fall below 4.5:1 on its background** (the reference's .3 alpha failed at 1.55:1).
System font stack, root 17px, `letter-spacing:-0.01em`, display -0.03em, `tabular-nums` on all
numerals. Type floor 13px (12px only for aria-hidden chrome). Radii 32/24/18/12, pill 999px.
Glass: `backdrop-filter: blur(44px) saturate(180%)` (+ `-webkit-`) on header, sticky bars, menu,
toasts; `blur(24px) saturate(180%)` on small floating chips. Mesh: one fixed ambient radial wash.
Motion: `cubic-bezier(.32,.72,0,1)`; 0.42s structural, 0.16–0.24s micro, `scale(.96)` on tap.
`@media (prefers-reduced-motion: reduce)` in base.css zeroes all durations.

## 3. Layout per breakpoint (deliberately different)
- Mobile <768px: thumb-first. Single column, ≥44px targets, sticky glass primary-action bar at
  the bottom (existing `data-primary-action[data-sticky="on"]`), mobile menu opens as a glass
  BOTTOM SHEET (same `.nav.is-open` hook), no hover-dependent anything.
- ≥768px: generous two-column tool layout (stage/result rail + controls rail), header nav inline,
  no bottom bar, no bottom sheet.
- enhance-photo is the flagship: a large dark stage frame holds the compare slider; style chips
  render as live circular thumbnails beneath; stats in a glass strip. Exceed the reference, keep
  the existing hooks (`data-preset-chip`, `data-intensity`, `data-advanced-*`, `data-compare*`).

## 4. Hard rules
1. Truth: nothing fake. No stats/badges/claims that aren't built. Web Workers are real (Comlink +
   OffscreenCanvas) — say "Web Worker" only in the prose that is true for that tool.
2. Zero external requests: no CDN/fonts/remote images/analytics. Inline SVG icons only.
3. Don't break logic/URLs/titles/SEO/hooks. Rename a hook → update every reference + test.
4. Plain semantic HTML + modern CSS + minimal vanilla JS. Existing deps are fine to keep.
5. RTL-first with logical properties; `<bdi dir="ltr">` around every number/unit; mirror icons.
6. Privacy message at most 3 times per page.
7. Saving goes through ONE shared module `src/assets/js/core/save-photo.js` (see §5).
8. WCAG AA contrast both themes, visible focus rings, keyboard operable, reduced-motion, ≥16px
   body, nothing under 12px, inputs ≥16px (no Safari zoom-on-focus).

## 5. save-photo.js — the one save path (owned by the Save agent)
Chain: (1) iOS/iPadOS or `navigator.canShare({files})` → `navigator.share({files})` inside the
user's tap on a PRE-RENDERED cached blob (no await in the handler); AbortError = silent;
NotAllowedError → fall through. (2) In-app webview (FBAN/Instagram/WhatsApp/TikTok/LinkedIn…)
or share refused → full-screen blob: viewer with "اضغط مطولاً على الصورة ثم اختر حفظ في الصور"
+ an "open in Safari" affordance. (3) Desktop/Android → `<a download>` blob: URL, revoked on
pagehide (not a 1s timer). Always show the REAL output size + format. Never `alert()`.

## 6. Known defects to FIX (from Phase 1 audit) — do not reproduce
### The one the owner reported (iOS save to Photos) — root cause CONFIRMED
- `.save-viewer-img` carries `-webkit-touch-callout:none; user-select:none;
  -webkit-user-drag:none` (copied from the compare slider). Those three declarations
  are exactly what removes "Save to Photos" from the iOS press-and-hold sheet. They
  belong ONLY on `.compare-slider`. The viewer keeps a plain real `<img>` with native
  callout. (Fixed 2026-09-21 — see DECISIONS D-002.)
- The viewer is `position:fixed; inset:0` and covers the header (breaks §4.7 style):
  it must sit below the header, `inset: var(--header-height) 0 0 0`, like the sheet.
- "Open in Safari" is shown while already in Safari: show it ONLY when
  `isInAppBrowser()` is true; `needsFallbackViewer` must not treat every iOS agent
  as a viewer case.
- No JPEG/PNG pre-render for the Photos path (4 of 5 tools default to WebP; iOS 13
  offers no "Save to Photos" for WebP). Pre-render JPEG (PNG if transparency
  matters) for the share, keep the original for Files, always name the real format.
- `saveFiles()` exists but no tool calls it: batches share all files in one call when
  `canShare` allows, else a swipeable viewer (one long-pressable image per screen) +
  ZIP to Files.
- `?debug=1` diagnostics overlay: path taken, canShare result, error name/message,
  blob type + size, filename, UA, webview/ios flags.
### Older list
- crop `fillColor:'#ffffff'` destroys PNG transparency → conditional per output format.
- compress `probeSize()` missing `imageOrientation:'from-image'` → wrong portrait dims.
- convert worker has no pixel-budget check; global 100 MP budget is not iPhone-safe →
  adaptive safe max + honest "تم تصغير الصورة إلى W × H" message with real numbers.
- dropzone extension map lacks heic/heif (empty-type HEIC rejected on convert).
- header missing `env(safe-area-inset-top)`; install banner missing bottom inset.
- `100vh`/`60vh` without `dvh` fallback.
- `.range-input` sliders not styled for `-webkit-slider-thumb`.
- `-webkit-touch-callout:none` on compare slider.
- two hardcoded English strings in resize-image.js → catalogue keys.
- blob URLs revoked on a 1s timer → pagehide.
- never `position:fixed` a full-screen studio over the header; the header always stays.

## 7. Verification every agent runs before finishing
`npm run gen` (must succeed) → `npm test` (must pass) → `npm run audit:seo` (must exit 0) →
`npm run build` + `npm run audit:pwa` (must exit 0). Report any rule you could not satisfy.

## 8. Font — Thmanyah is BLOCKED by license (DECISIONS D-001, BLOCKED B1)
The Thmanyah ZIP is real (3 families × 5 weights, OTF+WOFF2, one family covers
Arabic + Latin + Western digits), but its license expressly prohibits hosting the
font on a website for download, prohibits web embedding outside a
"compiled/packaged/obfuscated product", and prohibits modification and derivative
works (so no subsetting). A self-hosted `@font-face` WOFF2 fails all three.
**Do not copy any Thmanyah file into the repo and never commit the ZIP.** The
system-font stack stays; typography polish happens through the token type scale,
Arabic-first font ordering, `letter-spacing` and display optical settings. Unblocking
requires a written exception from `ask@thmanyah.com` or an owner-approved OFL family.

## 9. Studio Shell (Workstream C) — the contract for every tool page
One shared shell, six tools; only the inspector differs. All `data-*` hooks in the
Repo Map stay identical — a control may change element (`<select>` → segmented
control) as long as the hook attribute and its value space are unchanged.
- No forms: no "اختر الصور" heading, no `<select>`, no bare number field, no
  card-in-card, no dashed drop box. A single full-width glass drop surface; the page
  itself accepts drop and paste; one elegant "choose" control; the default operation
  runs the instant an image lands.
- Controls are direct and visual: segmented controls/chips for format and presets;
  sliders with big readouts; dimension presets as real selected chips ("الأصلي" is a
  selected chip, never a placeholder) plus custom entry with `inputmode="numeric"`,
  steppers and a ratio lock; target size as a slider with preset chips.
- Editing state: desktop = stage + slim inspector rail; mobile = stage + fixed
  compact control tray with one sticky primary "حفظ" (safe-area aware). Before/after
  with REAL sizes and % saved, batch filmstrip, per-image status.
- Any new numeric readout needs a `unicode-bidi: isolate` entry in `rtl.css`.
- `remove-background` is planned/unimplemented — out of scope.

## 10. Copy (Workstream A) — COPY.md is the single source of truth
Final naming set (nav + cards only): تخفيف / الأبعاد / الصيغة / الإطار / ملف PDF /
لمسة, each with its one-line subtitle; EN: Compress / Resize / Convert / Crop / PDF /
Enhance. Delivered via new `cardName`/`cardSubtitle` keys; `name`/`title`/`h1`/
`description` keep the descriptive SEO terms (ضغط الصور … تحسين الصور). Verbs:
تنزيل (file leaves the page), حفظ (file on device / stored preference), تصدير banned.
No Latin script inside Arabic prose except format names (JPEG, PNG, WebP, PDF, HEIC,
AVIF, ZIP), size units (KB, MB, px) and bracketed proper names (Lanczos, Safari, A4).
Workers are «مسار خلفي», never "Web Worker" in Arabic prose. `js.*` strings are
`textContent`-injected → no markup, no `<bdi>`; `ui.*` may carry `<bdi dir="ltr">`.
