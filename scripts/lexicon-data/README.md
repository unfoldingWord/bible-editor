# Bundled Strong's Dictionary lexicon data

This directory holds public-domain Strong's Hebrew and Greek Dictionary entries
mirrored from translationCore's bundled resources. They feed the **baseline
phase** of `scripts/import-lexicon.mjs` (the unfoldingWord UHAL/UGL master is
then overlaid on top — see the script header).

| File | Source | Entries |
|---|---|---|
| `uhl-contents.zip` | `tcc-ge-dcs/translationCore/tcResources/en/lexicons/uhl/v0.1_Door43-Catalog/contents.zip` | 8,674 Hebrew (H1–H8674) |
| `uhl-index.json` | same dir, `index.json` | `{id, name}` per entry — supplies Hebrew lemmas |
| `ugl-contents.zip` | `tcc-ge-dcs/translationCore/tcResources/en/lexicons/ugl/v0_Door43-Catalog/contents.zip` | 5,408 Greek (G1–G5408) |

Each `content/{n}.json` inside the zip is `{ "brief": "...", "long": "..." }`.
`brief` is a short gloss; `long` is the full Strong's entry (with inline `<i>`
and `<br/>` we strip during import).

## Why mirror them here?

The upstream Door43-Catalog repos (`Door43-Catalog/uhl`, `Door43-Catalog/ugl`)
have been removed from DCS — both return 404 as of 2026-05-14. The
translationCore bundle is the only surviving copy. The data is public-domain
classic Strong's Dictionary, so checking it into this repo is fine and avoids
relying on a third-party source we can't refresh.

## Update procedure

If translationCore ever updates its bundled lexicons:

```powershell
Copy-Item ..\tcc-ge-dcs\translationCore\tcResources\en\lexicons\uhl\v0.1_Door43-Catalog\contents.zip scripts\lexicon-data\uhl-contents.zip
Copy-Item ..\tcc-ge-dcs\translationCore\tcResources\en\lexicons\uhl\v0.1_Door43-Catalog\index.json   scripts\lexicon-data\uhl-index.json
Copy-Item ..\tcc-ge-dcs\translationCore\tcResources\en\lexicons\ugl\v0_Door43-Catalog\contents.zip   scripts\lexicon-data\ugl-contents.zip
node scripts/import-lexicon.mjs
```
