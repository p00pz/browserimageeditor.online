# DIAGNOSIS — why the owner saw "nothing changed"

Verified 2026-09-21 by reading git, the live site, and the local servers.

## The finding (in one line)

Every change exists only on the unmerged branch `overnight/20260921` — half of it still
**uncommitted in the working tree** — while the live site at `browserimageeditor.online`
deploys from `main`, which has **none of it**. Nothing was ever merged or deployed. It is
not a caching mystery: the work never left the branch.

## Evidence

1. **`main` is the deployed site and it is the old code.**
   - `git show main:src/partials/ar/nav-tools.html` → old labels:
     الضغط · المقاس · التحويل · القص · صور إلى PDF · التحسين.
   - `git show main:src/assets/js/ui/studio.js` → *does not exist on main*.
   - Live site `https://browserimageeditor.online/ar/tools/compress-image/` returns HTTP 200
     with the **old** nav labels and no studio markup. That is exactly what the owner tested.

2. **`overnight/20260921` (current branch) holds the work, and 41 files are uncommitted.**
   - Committed here: copy rewrite (`66cafc8`), Studio Shell on compress (`f351e2c`).
   - **Uncommitted in the working tree**: the shell applied to the other 5 tools × 2 locales
     + all 13 target pages, plus `components.css` and `studio.js` tweaks. The owner can never
     see work that is not committed, let alone merged and deployed.

3. **The font was never going to change — by licence, not by oversight.**
   - `Thmanyah-Font-Family.zip` → `LICENSE.pdf`, read in full (5 pages, extracted with pypdf).
   - Permitted: "Embed … in websites … **only as part of a compiled, packaged, or obfuscated
     product**." Prohibited: "host, or make the Font Software available for download on any
     website"; "extract, download … **independently as font files, including through web
     embedding**"; "Modify … or reverse-engineer" and "Create Derivative Works" (so subsetting
     is barred too). Governing law: Saudi Arabia / courts of Riyadh.
   - A self-hosted WOFF2 served from an open-source repo fails all three: it is hosted for
     public download, it is not a compiled/obfuscated product, and the repo makes extraction
     certain. The prior run stopped at the mission's own step-1 stop condition (BLOCKED.md B1).
   - Zero `@font-face`, zero font files in the repo or in `dist/` — confirmed by directory
     listing. There was nothing to load.

4. **Caching could have hidden a change, but there was no change to hide.**
   - `dist/sw.js` precaches the app shell and serves `/assets/*` cache-first (content-hashed, so
     a new build cannot go stale) and navigations network-first. The mechanism is sound; it only
     matters once a new build is actually deployed.
   - CSS is not overridden by a late-loaded second file: 4 stylesheets total, `base.css` owns the
   single `--font-sans` token, `rtl.css:83` carries one *hard-coded* stack (a real defect — it
   bypasses the token; fixed in this strike), `components.css` uses `--font-mono` only.

## What each page loads

One shared set for every page, both locales: `base.css`, `components.css`, `layout.css`,
`rtl.css` (AR only), plus per-tool JS chunks. Six tool scripts, six engine modules, five real
Web Workers (compress/convert/enhance/pdf/resize) via Comlink. No second CSS file overrides the
theme; no inline `<style>` block sets `font-family` anywhere in the repo.

## How the site is served

- `npm run dev` → Vite MPA dev server on **5173/5174** (root `src/`, `#include` partials inlined
  by the `partialsPlugin`, so dev and build can never disagree).
- `npm run build` → `dist/` (55 routes), then `postbuild` generates `sw.js`.
- Verification in this strike: `npx vite preview` on **4173** serving the rebuilt `dist/`.

## Branch decision

Continuing on **`overnight/20260921`** (from `main` @ `e948858`, backup at
`backup/overnight-20260921-start`). It holds good work: the copy rewrite, the save-to-Photos
fix, the header/menu-sheet chrome, and the Studio Shell reference implementation. Nothing is
redone; the uncommitted shell work is completed, verified and committed instead.

## The fix this strike actually delivers

- Commit the 41 uncommitted files after verification (they were the invisible 90% of Goals 2–3).
- Rebuild `dist/` so a preview shows the real result.
- Goal 1 is **stopped by licence** (see REPORT.md §"Goal 1"); the token architecture a font drop-in
  needs is built instead, so the day written permission arrives, shipping Thmanyah is a diff.
