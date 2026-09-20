# PROGRESS.md — lead memory across the run. Read at the start of every phase.

Branch: `overnight/20260921` (from `main` @ e948858). Backup: `backup/overnight-20260921-start`.
Baseline verified on this branch: `npm run gen` clean, `npm test` 242/242 pass,
`npm run build` succeeds, `npm run audit:pwa` 0 errors (2 size warnings),
`npm run audit:seo` exit 0, working tree clean except the untracked font ZIP.

## Phase 0 — DONE
- Branch + backup created. Git identity present (muayid saif / p00pz@…).
- Baseline audits stored (above). No Lighthouse available offline; `audit-seo` +
  `audit-pwa` + the node:test suite are the gate. `@playwright/test` is a dev
  dependency and node_modules is installed; browser binaries TBD (check
  `%LOCALAPPDATA%\ms-playwright`).
- Phase-1 read-only specialists reported (Repo Map, Save-Flow Investigator, Copy
  Editor → COPY.md, Font Analyst). Findings folded into DECISIONS.md.

## Phase 1 — DONE (findings, read-only)
- **Repo Map** (see DECISIONS/DESIGN_BRIEF): full `data-*` hook map per tool JS,
  generation flow, CSS ownership with line ranges, one 768px breakpoint (JS-hardcoded),
  rtl.css delta list (bidi isolation classes must follow any new numeric readout),
  `layout.css:429` is the only `vh` without a `dvh` twin.
- **Save flow** (DECISIONS D-002/D-003): root cause = 3 CSS declarations on
  `.save-viewer-img`; plus 6 secondary defects with a prioritised fix plan.
- **Copy** (COPY.md): naming set + ~40 rewrites keyed by JSON path, plus the
  `cardName`/`cardSubtitle` mechanism and the one build-script line it needs.
- **Font** (DECISIONS D-001, BLOCKED B1): license blocks self-hosting; stream stopped.

## Phase 2 — IN PROGRESS (no file overlap between agents)
| # | Workstream | Owner | Files (exclusive) | Status |
|---|---|---|---|---|
| B | Save to Photos fix | lead | `core/save-photo.js`, `components.css` save-viewer block, `tests/save-photo.test.js` | next |
| E1 | Language switch into header + sheet | lead | `build-pages.mjs`, `tool-page.mjs`, 5 templates, `header.html`×2, `layout.css`, `components.css` lang-switch block | next |
| E2 | Header opacity, menu sheet (frost/lock/trap/Esc), hero wrap | lead | `layout.css` header/nav-sheet/hero blocks, `ui/site.js` | next |
| D | Thmanyah font | — | none | BLOCKED (B1); system stack polished instead |
| A | Apply COPY.md | agent | `content/ar/*.json`, `content/*.json` EN mirrors, `src/templates/ar/*.html`, `src/templates/*.html` EN mirrors, one line in `tool-page.mjs` | next (dispatch after B/E1 land, or in parallel — file sets are disjoint from B/E1) |
| C | Studio Shell | lead (compress as reference) then agents (5 tools × 2 locales) | `src/templates/{ar/,}tools/*.html`, `components.css` tool blocks | after E1 |

GATE after Phase 2: lead reviews, `npm run gen && npm test && npm run build` must be
green, else reject and reassign.

## Phase 3–5 — planned
Studio Shell on all six tools (compress first as the reference implementation, then
one agent per tool, both locales), home + info-page polish, EN mirrors, then the QA
ratchet: visual (390/768/1440, light/dark, AR/EN), functional (small/huge/EXIF
portrait/transparent PNG/WebP/batch-with-invalid), iOS WebKit save paths,
accessibility, performance, truth+privacy (network log: zero third-party requests),
SEO, hygiene. Ratchet up to 8 rounds; stop early on two clean rounds.

## Decisions log → DECISIONS.md (D-001..D-006)
## Blockers → BLOCKED.md (B1: Thmanyah license)

## Risks
- Playwright browser binaries may be absent → iOS verification becomes a static
  + unit-test audit; the `?debug=1` overlay is the owner's on-device confirmation.
- Studio Shell touches every tool template; a hook rename would break tool JS.
  Mitigation: the Repo Map hook list is the contract; `npm test` after each tool.
- Two parallel agents editing `content/*.json` (A) vs `templates/*.html` (C) must not
  both touch `tool.template.html`; A edits page templates + JSON, C edits tool
  templates only. Enforced by this table.

## Next
1. Workstream B save fix (lead). 2. E1 language switch (lead). 3. E2 chrome polish.
Then dispatch A (copy) and C (shell) in parallel.
