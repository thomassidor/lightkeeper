# Documentation index

Every document in this repository, and who it is for. None of `docs/` is bundled into the app.

> [!WARNING]
> **Lightkeeper is in early development (0.x), and an update can break a setup somebody already
> made.** Nothing below is frozen — stored shapes, settings and pairing screens all still move. See
> [`../FAQ.md` → Is this finished?](../FAQ.md#is-this-finished) for what that means for a user, and
> [`../CHANGELOG.md`](../CHANGELOG.md) for what actually changed.

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
| [`commands.md`](commands.md) | **Every command in one place** — test, typecheck, sync the views, render them, install on a Homey, run the hardware pass, record a week at home, probe the lights, release. With each one's traps |
| [`../CLAUDE.md`](../CLAUDE.md) | The architecture, the conventions, the release checklist, and why each dependency is pinned. Written for agents and maintainers alike |
| [`homey-platform.md`](homey-platform.md) | **Eighteen sections on how Homey actually behaves**, established against real hardware and documented nowhere else. The code cites it as `platform §n`. §15 is also where the memory number lives — an empty Homey app is 30.6 MB, so read it before optimising for memory |
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
| [`design/`](design) | **The design system and the flows it is applied to** — five type sizes, four radii, three border roles, two button shapes, and all 34 pairing screens drawn against them. Its README says what they are the authority on, where the two canvases disagree, the seven places the shipped app deliberately departs, and the one question still open. `npm run render:views` draws the artefact to put beside it |

`npm run render:views` draws every screen to `.views/` and is the other half of that comparison:
the canvas says what it should look like, the render says what it does. Neither runs in CI — both
need Chrome, and the second needs a person.
