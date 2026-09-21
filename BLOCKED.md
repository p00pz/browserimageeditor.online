# BLOCKED — parked items, each with a path to unblock

## B1 — Thmanyah font cannot be shipped (license) — BLOCKED, do not ship

Owner request (Workstream D): apply the Thmanyah (ثمانية) family site-wide.

The ZIP `Thmanyah-Font-Family.zip` lives OUTSIDE the repo (never committed, never
copied). Contents, verified by extraction to a temp folder:

- 3 families: `thmanyah sans`, `thmanyah serif text`, `thmanyah serif display`.
- 5 static weights each (Light 300 / Regular 400 / Medium 500 / Bold 700 / Black 900),
  OTF + WOFF2, no variable fonts, no italics, ~1,520 glyphs each.
- One family covers Arabic (U+0600–06FF, full harakat, Presentation Forms-A/B) AND
  Basic Latin + Western digits 0–9 + `، ؛ ؟`. No separate Latin family needed.
- Already-WOFF2 files are 72–83 KB each; a subset would be ~53–60 KB/weight.

License: **"thmanyah's Font License"**, © 2026 thmanyah Publishing and Distribution,
Reserved Font Name "thmanyah", Saudi law / Riyadh courts. Read in full from
`LICENSE.pdf` (English, 5 pages; the Arabic version prevails per its LANGUAGE clause).
Binding text:

- Permitted: "Embed the Font Software in websites, web applications, mobile
  applications, or software products **only as part of a compiled, packaged, or
  obfuscated product**."
- Prohibited: "**Redistribute, share, upload, host, or make the Font Software
  available for download on any website**, server, digital platform, or
  file-sharing service."
- Prohibited: "Make the Font Software available in any manner that allows end
  users or third parties to extract, download, access, reuse, or redistribute the
  Font Software **independently as font files, including through web embedding**,
  applications, or software products."
- Prohibited: "**Modify, edit, adapt, translate, or reverse-engineer** the Font
  Software in any way" and "**Create Derivative Works**" — so subsetting is barred.

A self-hosted WOFF2 under `/fonts` served by `@font-face` is (a) hosting the font on
a website where anyone can download it, and (b) not a compiled/packaged/obfuscated
product. Subsetting would add a derivative-work violation. The repo is open source
and the built assets are public, so third-party extraction is certain. Shipping it
would also break the site's own hard rule (Truth: no hidden problems) and expose the
owner to a Saudi-court copyright claim with a takedown demand.

**Decision:** Workstream D is stopped at its own step-1 stop-condition. **No Thmanyah
file enters the repo.** The ZIP stays untracked. The existing system-font stack is
kept and the type system is polished instead (DESIGN_BRIEF §2, §8).

**Re-verified this strike (2026-09-21).** I extracted the archive and read `LICENSE.pdf`
myself — 5 pages, via pypdf — rather than relying on the earlier summary, and the three
binding clauses hold exactly as recorded above. Confirmed additionally: the type
architecture a permitted font needs is now in place, so unblocking is a diff and not a
project — `--font-body`/`--font-display` tokens, form controls inheriting letter-spacing,
`rtl.css` no longer overriding the token with a hard-coded stack, and a commented
`@font-face` drop-in slot in `base.css` marking where the licensed family goes. Measured
on all 14 pages: 0 external requests, 0 font requests. See REPORT.md "Goal 1".

**To unblock — owner picks one:**

1. Obtain a **written web-embedding exception** from `ask@thmanyah.com` (the address
   the license itself names for exceptions) that permits `@font-face` self-hosting
   and subsetting; commit that permission next to the font files. The full pipeline
   (extract → subset with fontTools → `/fonts` → `@font-face` + preload + metric
   fallback) is already specified in DESIGN_BRIEF §8 and can be executed in one pass.
2. Or approve a swap to an **OFL-licensed** Arabic family that permits self-hosting
   and subsetting — Cairo, Tajawal, IBM Plex Sans Arabic, Readex Pro, or Noto Naskh
   Arabic. One word from the owner and it is a short, safe change.

Not done unilaterally: the owner asked for Thmanyah by name; a surprise substitution
changes the site's identity and still would not satisfy the request. An honest
blocker with a one-step unblock beats a silent substitution.

## B2 — (none yet)
