# Documentation index

Every document in this repository, and who it is for. None of `docs/` is bundled into the app.

## If you use the app

| Document | What is in it |
|---|---|
| [`../README.md`](../README.md) | What Lightkeeper is, what the five device types do, and how to set one up |
| [`../FAQ.md`](../FAQ.md) | Troubleshooting, the limits in full, what Repair fixes, and how to remove it |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Every release in full. The README has the short version |
| [`privacy.md`](privacy.md) | What the app reads, what it stores, what it never transmits, and for how long |

## If you work on the app

| Document | What is in it |
|---|---|
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | **Start here.** Setup, the house rules, and what must pass before a PR |
| [`commands.md`](commands.md) | **Every command in one place** — test, typecheck, sync the views, render them, install on a Homey, run the hardware pass, probe the lights, release. With each one's traps |
| [`week-long-testing.md`](week-long-testing.md) | Start a persistent seven-day recording, annotate observations, export and analyze the evidence |
| [`evidence-findings.md`](evidence-findings.md) | **What a real 3.83-day recording found** — six defects, the numbers behind each, and the two things that only looked like defects |
| [`open-work.md`](open-work.md) | **What is known to be unfinished, and nothing else** — tests owed, two one-line defects, the structural programme, and three questions only hardware can answer |
| [`decisions.md`](decisions.md) | Five arguments that outlived the documents they were written in, and that shipped code still cites |
| [`../CLAUDE.md`](../CLAUDE.md) | The architecture, the conventions, the release checklist, and why each dependency is pinned. Written for agents and maintainers alike |
| [`homey-platform.md`](homey-platform.md) | **Seventeen sections on how Homey actually behaves**, established against real hardware and documented nowhere else. The code cites it as `platform §n` |
| [`memory-investigation.md`](memory-investigation.md) | **Why the app's footprint is what it is, measured against a control app installed beside it.** An empty Homey app is 30.6 MB; read this before spending a day on the memory number |
| [`hardware-test-plan.md`](hardware-test-plan.md) | **The standing pass on a real Homey, run before every release.** What to do and how to report it, and nothing else |
| [`hardware-test-coverage.md`](hardware-test-coverage.md) | What the script covers, what the suite covers instead, and which old test-plan lines were retired |
| [`localisation.md`](localisation.md) | The app is English-only on purpose; how to add a language back, and the glossary kept from the removed Danish |

## If you review the app

| Document | What is in it |
|---|---|
| [`homey-review-notes.md`](homey-review-notes.md) | For Athom's reviewer: why `homey:manager:api` and a user-supplied Personal API Key are both unavoidable, plus what is still untested |
| [`privacy.md`](privacy.md) | The privacy notice, same file as above |

## If you touch the artwork

Everything graphic lives in [`../artwork/`](../artwork), a sibling of the `assets/` it generates —
masters, the export script, and its own two documents:

| Document | What is in it |
|---|---|
| [`../artwork/asset-spec.md`](../artwork/asset-spec.md) | The brief: every graphic the app ships, what it is for, the sizes Homey requires, and the prompts the photographs came from |
| [`../artwork/provenance.md`](../artwork/provenance.md) | Where the artwork came from, the palette's source, the rights register, and the gaps the record itself notes |

Nothing shipped is hand-edited: `python artwork/export-assets.py` builds every icon and image from
`artwork/masters/`, and an edit to a shipped file is lost on the next export.

## If you change how a setup screen looks

| Document | What is in it |
|---|---|
| [`design/`](design) | **The Claude Design canvas the 0.6.0 pairing rewrite was built from** — all five device flows, one row each, happy path plus the special cases. Its README carries the four turns that arrived at it and the six places the shipped app deliberately departs from it. The durable visual reference the views are compared against |

`npm run render:views` draws every screen to `.views/` and is the other half of that comparison:
the canvas says what it should look like, the render says what it does. Neither runs in CI — both
need Chrome, and the second needs a person.
