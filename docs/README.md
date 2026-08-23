# docs

Reference material that outlives any one release. Excluded from the app bundle
by `.homeyignore`, so nothing here ships to a Homey.

| File | What it is for |
|---|---|
| [`homey-review-notes.md`](homey-review-notes.md) | The answers Athom's review will ask for — why this app needs `homey:manager:api` and a Personal API Key — plus a test script and the honest list of what is untested. |
| [`privacy.md`](privacy.md) | What the app reads, stores and never transmits. Needed because it handles a credential. |
| [`localisation.md`](localisation.md) | The app is English-only. This is how to add a language back, and the glossary from the Danish translation that was removed. |
| [`asset-spec.md`](asset-spec.md) | **What to produce**: every asset Homey requires, its exact size, and the rules that decide whether it is accepted. One page, written to be handed to whoever draws the next set. |
| [`artwork.md`](artwork.md) | **Why ours look like this**: palette, the icon rules and why they are line art, how the two masters were generated, how to re-export every shipped PNG — and which asset rules Homey *validates* versus which a reviewer merely applies. |
| `artwork/masters/` | The two source images. The only artifacts here that cannot be regenerated: the icons are SVG in the app itself, and every shipped PNG is a crop of one of these two. |
| `artwork/export-assets.py` | Regenerates all nine shipped PNGs from those masters. |

Everything a user needs is in the top-level [`README.md`](../README.md) instead —
requirements, setup, how it works, limits and troubleshooting. Architecture and
the Homey platform reference live in [`CLAUDE.md`](../CLAUDE.md).

This folder replaced a `release-materials/` tree that had accumulated a reseller
brief, incident-communication templates, a customer-service escalation script and
a performance-dashboard specification, for an organisation that does not exist —
alongside byte-for-byte copies of `README.txt` and `.homeycompose/app.json`.
Duplicating files Homey already reads is worse than not having them: the copy
drifts and nobody knows which one is real. If something here starts describing a
process rather than recording a decision, it has gone the same way.
