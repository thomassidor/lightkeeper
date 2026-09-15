# Decisions worth keeping

Five arguments that outlived the documents they were written in. They came from the 0.5.0
remediation archive (`docs/history/`, removed — `git log --diff-filter=D -- docs/history` finds it),
and they are here rather than there because shipped code still cites them and because nothing else
in the repo records them.

Everything else that archive held turned out to be duplicated in the code it explains: the relaxed
lint rules in `eslint.config.mjs`, the weekly-overlap framing at `lib/schedules/schedule-window.ts:187`,
the permanent legacy device-id shape in its own regex comment, the `@tsconfig/node16` pin at the top
of `tsconfig.json`, the `reconstructed` fixture corpus in `test/fixtures/cards/README.md`, and the
icon-geometry check in `test/unit/assets.test.ts`. That is the test for anything else that wants to
be added here: **if a code comment can carry it, put it there instead.**

---

## 1. There are five binding kinds, and `flow_enum` was not folded into `flow_fixed`

Cited by `lib/inputs/selectable-input.ts`.

The fold is tempting and it cannot keep the variant key stable, which is the thing that matters.
After folding, the enum value sits in `fixedArgs` beside any selector and direction, and nothing
distinguishes which entry was the enum — so the compiler cannot rebuild `enum:<value>`. The
alternatives were a variant key hashed from `fixedArgs` (not the stated key, and it churns every
installed controller's Flows, because reuse is keyed on the variant key) or storing a redundant
`variantKey` inside the binding, which is one more field than the kind it removes.

The real finding underneath was different and did land: **`fixedArgs` belongs on all five kinds.**
`bindingFor()` built the selector/direction object and handed it to three of four kinds;
`flow_range` got the magnitude argument alone, so a card with a selector AND a direction AND an
enumerated step compiled to one Flow per step, none naming the button or the direction — every
variant fired on every control. `binding-shape.test.ts` asserts twelve distinct triggers where there
were three.

An enum binding's `fixedArgs` is `{}` and its value lives in the variant; the compiler merges the
two, so putting the selector in both would set it twice.

## 2. An app-level `type: "device"` argument is declined on purpose

Cited by `test/unit/card-fixtures.test.ts`.

Such a card IS matched to the device (route `device_arg`) and then declined, because
`classifyArgument` returns `unsupported` for any non-dropdown type. Pre-binding the device argument
into `fixedArgs` is mechanically trivial. The blocker is the VALUE: a `device` argument's accepted
serialisation is not something this app can enumerate ahead of time. `platform §5` records that
autocomplete arguments serialise as the whole selected object rather than an id, and §9's
`time_exactly_day` is the standing example of what guessing an argument shape costs — a Flow that
validates and never fires, which is the worst failure this app has.

Repo law is not to guess a platform shape, so the decline stands. What changed is that it now names
the type — `argument "device" is of type "device", which this app cannot enumerate into events` —
rather than saying "is not enumerable". Every reference device resolves through `device_scoped`, so
nothing shipped depends on this route.

**What a fix needs:** one `getFlowCardTriggers()` capture of such a card, plus one hand-built Flow
through the Web API setting that argument, to read back how the value serialises. Until then, do not
implement it.

## 3. An unevaluable filter key fails closed, contradicting an older comment on purpose

`deviceMatchesFilter`'s old default branch said unknown keys "are ignored rather than treated as a
mismatch: failing closed here would silently hide usable cards." That reasoning is inverted now.
Ignoring a restriction we cannot evaluate reads as "the filter does not restrict on that", which is
the opposite of what a filter is. The concern the old comment protected — a silently absent card —
is met instead by REPORTING the decline with the key named, which `discover()` returns in
`rejected`. `device_scoped` does not go through a filter at all, so no reference device is affected.

## 4. `InvalidRangeError` reaches the user through the `unsupported` path

Cited, with two other citations that still resolve, by `lib/bridge/flow-bridge-manager.ts`.

`flow_range.values` is the card's exact sorted, de-duplicated set, and the ceiling counts
`values.length` — so {1, 1000} is two Flows, where comparing the SPAN against the ceiling used to
decline a two-detent control as if it needed a thousand variants. The old count-up loop between two
NaN endpoints was not an error but an empty loop: the control silently compiled to nothing. Hence
`InvalidRangeError`, surfaced through the same `unsupported` path the ceiling refusal uses, so the
device reports repair and names the control rather than failing anonymously.

The migration derives `values` from the stored endpoints rather than from the live card, because a
migration must be a pure function of what is on disk.

## 5. Two things the remediation deliberately did not do

- **The app-level generated-resource registry with per-Flow nonces** was declined in favour of the
  scoped version that shipped: installed-device liveness, template-match attribution, and a creation
  journal. That delivers most of the safety for much less machinery. It stays a documented option if
  the scoped approach ever proves insufficient on hardware.
- **Build-time view fragments (LK-064)** were parked, and the cheap half taken instead. What became
  of it is `views/shared/` plus `npm run sync:views`; `CLAUDE.md` records what is still unmeasured
  about a real `<link>` / `<script src>` inside an injected pair view.
