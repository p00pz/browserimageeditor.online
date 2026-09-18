# Vendored font — why this file is in the repo

`scripts/gen-og.mjs` needs the actual font data to outline glyphs into the social cards. Reading a
system font instead would mean Windows drawing Segoe UI and Linux drawing DejaVu, so the same run
would produce different bytes on different machines — which breaks the rule every generator here
follows (a re-run must be a no-op).

Both files are **build-time only**. They are never copied into `public/`, never served to a
visitor, and never bundled into the site.

## What is here

| file | family | weight | bytes | sha256 |
|---|---|---|---|---|
| `IBMPlexSans-Regular.ttf` | IBM Plex Sans | 400 | 200,500 | `975dcda37d80f038dcd143c22e33ca2d97a0cc5a929aace1c749153b0fe1afa5` |
| `IBMPlexSans-Bold.ttf` | IBM Plex Sans | 700 | 200,872 | `9e6c74a889a700d707613d24548fe4ffa6bc59559a0689d2cf9e133bdcdafb2f` |
| `LICENSE.txt` | — | — | 4,456 | the font's own licence file, as published |

## Provenance

- Upstream: <https://github.com/IBM/plex>
- Path: `packages/plex-sans/fonts/complete/ttf/`
- Fetched from commit **`c5f949677f6f163e8dfe98ca2c326bd48b42fa1b`** — the commit that last touched
  the font path, used instead of a branch name so this stays reproducible:
  `https://raw.githubusercontent.com/IBM/plex/c5f949677f6f163e8dfe98ca2c326bd48b42fa1b/packages/plex-sans/fonts/complete/ttf/IBMPlexSans-Regular.ttf`

## Licence

The font's own `LICENSE.txt` (vendored above) begins:

> Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"
>
> This Font Software is licensed under the SIL Open Font License, Version 1.1.

SIL Open Font License 1.1 — permissive, allows embedding and redistribution, requires that the
licence travel with the font (it does) and that a modified version not use the reserved name
"Plex" (nothing here is modified).

If this font is ever replaced, update the checksums above and the table in `PROGRESS_LOG.md`.
