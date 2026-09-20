# DECISIONS.md — lead decisions, newest last

## D-001 Font: Thmanyah is blocked by its license; system stack kept and polished
Verified the license text directly (`LICENSE.pdf` in the extracted ZIP). Web
embedding is permitted only "as part of a compiled, packaged, or obfuscated
product"; hosting the font on a website for download is expressly prohibited,
"independently as font files, including through web embedding"; modification and
derivative works (i.e. subsetting) are prohibited. A self-hosted `@font-face` WOFF2
fails all three. Stopped Workstream D per its own stop-condition; no font file enters
the repo; the ZIP never gets committed. Path to unblock and OFL alternatives are
recorded in BLOCKED.md B1. Workaround delivered: the existing system-font stack is
refined (Arabic-first ordering, tighter type scale, display optical settings) so
typography still reads as premium in both themes and both languages.

## D-002 Save to Photos root cause: three CSS declarations, not a logic bug
The share chain is structurally sound (share fires synchronously inside the tap on a
pre-rendered File; first `await` in `saveBlob` is `navigator.share` itself; user
activation survives). The failure is `.save-viewer-img` carrying
`-webkit-touch-callout: none; user-select: none; -webkit-user-drag: none` — copied
from the compare slider, where they belong. Those three declarations are exactly what
removes "Save to Photos" from the iOS press-and-hold sheet. Fix: remove them from the
viewer (keep them on the compare stage), then fix the surrounding defects the audit
found (viewer covering the header, "Open in Safari" shown inside Safari, no
JPEG/PNG pre-render for a WebP output, dead `saveFiles`, no diagnostics).

## D-003 iOS save format: pre-render JPEG/PNG for the Photos path, keep the real file
iOS 13 and some iPadOS builds do not offer "Save to Photos" for WebP. Four of five
image tools default to WebP output. So the save chain shares a **pre-rendered**
JPEG (or PNG when transparency matters) File when the output is not already
JPEG/PNG, while the original WebP is kept for the Files/`<a download>` route and the
on-screen size/format readout always names the real format. Truth rule respected: the
user is told when a JPEG copy is what lands in Photos.

## D-004 Language switch moves into the header (desktop) and the menu sheet (mobile)
Today `{{{langSwitch}}}` is emitted per page by `scripts/lib/tool-page.mjs` into a
full-width row under the header on every page. It cannot live in a static partial
because the href is per-route. Decision: generate a fifth per-locale partial
`partials/{{partials}}lang-switch.html` in `build-pages.mjs` (same pattern as
`navToolsPartial`), include it inside `.header-inner` for desktop and inside
`.nav-sheet` for mobile, and drop the `{{{langSwitch}}}` token from the five
templates. `hreflang`/`lang` stay on the links so `audit-seo` still passes.

## D-005 Copy: one naming set, descriptive terms stay in the SEO surface
Final set تخفيف / الأبعاد / الصيغة / الإطار / ملف PDF / لمسة with subtitles, applied
only to navigation and UI cards via new `cardName`/`cardSubtitle` keys; `name`,
`title`, `description`, `h1`, `keywords`, `faq` keep the descriptive terms
(ضغط الصور … تحسين الصور) so search and the breadcrumb/schema names are untouched.
COPY.md is the single source of truth; see PROGRESS.md for the apply status.

## D-006 Studio Shell: rewrite the six tool templates around one shared shell
The owner rejects the "اختر الصور / صيغة الإخراج + native select + number fields"
pattern. Decision: one shell (markup pattern + CSS block + the existing JS hooks),
applied to all six tools. Constraints that make it safe: every `data-*` hook the tool
scripts query stays exactly as mapped (Repo Map §1); native `<select>` → segmented
control/chips; number fields → sliders + preset chips + steppers with
`inputmode="numeric"`; the dashed drop box → one full-width glass drop surface; the
page itself accepts drop and paste; the default operation runs the moment an image
lands. `remove-background` is a planned (unimplemented) tool page and is out of scope.
