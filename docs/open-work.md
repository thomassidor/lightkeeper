# Open work

What is known to be unfinished, and nothing else. Every line here was carried out of the
9 September 2026 remediation pass, whose closed findings are in the git history rather than in the
tree — `git log --diff-filter=D -- CODE_REVIEW.md` finds the document, and the commit that removed
it says why.

Two other live lists exist and are **not** repeated here, because they are already where they
belong:

- [`hardware-test-plan.md`](hardware-test-plan.md) §4 — the unchecked lines for the current release.
- [`hardware-test-coverage.md`](hardware-test-coverage.md) — the T91–T97 table of hardware checks
  that automated evidence only partly covers.

---

## 1. Tests owed for the launch-review implementations

The fixes landed; their regression tests did not. Each is a finding whose behaviour is now relied on
by the code, with nothing pinning it.

| Finding | What shipped, untested |
|---|---|
| **R2** | `stopDependenciesOf()` — a normal hold mapping had no working release path |
| **R4** | `requireTarget` + `targets.noneSelected` — clearing a target selection retained the previous saved one |
| **R5** | Read-client replacement rebinding its subscribers (service, catalogue, adapter — three tests, plus a hardware line) |
| **R6/R7** | The replacement journal. **The riskiest piece.** Five specific gaps: where the journal lives, `removeAll` clearing it, per-owner serialisation, tolerating an undeletable staged id, and the why-comment deleted during the rewrite |
| **R9** | Accepted target groups exceeding the scheduler's capacity — the cap at pairing, with its locale key |
| **R10** | Setup tests reporting planned commands as successful lights — the typed outcome summary |
| **R12** | An in-flight credential save undoing Remove key |

R6/R7's journal is worth doing alongside **S-1** below, so the journal gets a file of its own.

## 2. Two one-line defects, both still present

Verified against the working tree on 14 September 2026:

- **R3 — an inverted default.** `RampEngine.start` takes `targetIds?: string[]`
  (`lib/outputs/ramp-engine.ts:96`) and reads it as `(ramp.targetIds ?? [])`, so "unspecified" means
  "write nothing". Make it required.
- **R8 — a dead field.** `pendingColor` in `lib/circadian/circadian-runtime.ts` is written at :1089
  and deleted at five sites. It is never read. Remove it, or restore the read it was added for.

## 3. Findings with no test, and the low tail

- **M-5** — the target fingerprint watches three capabilities while a plan is built from six. The
  widening shipped; it has no test.
- **M-7** — `LuminanceSource` mutating its owner map outside the per-sensor lock. Needs
  re-verifying against the rewritten `lib/daylight/luminance-source.ts`, which is not the file the
  finding was written against.
- **L-9** — `name: a?.name` is typed `string` and may be `undefined`; two fingerprints sort on it.
- **L-12** — a `light_mode`-only success creates a `lastWritten` entry with no axis.
- **L-13** — same constant names, different values, in different files.
- **L-16** — a "brighter" hold at full brightness writes `dim 1` on every flush for ten seconds.
- **L-17** — `flowsHealthy` is set true BEFORE the schedule's sync resolves.
- **L-20** — the shared daylight card's `getDaylight` does not retain its sensors on the way in.

## 4. The structural programme, untouched

S-1 … S-15. Three of them are recommendations **against** a change and are answered, not owed:
**S-3** (leave `api.ts` as it is), **S-11** (no migration-step factory), **S-12** (do not lift the
four managers past S-6). The rest:

| | |
|---|---|
| **S-1** | Split `flow-bridge-manager.ts` along three seams the file already has |
| **S-2** | Type the flow seam that `lib/homey-api-types.ts:17-27` explicitly invites |
| **S-4** | Small duplications in the spine |
| **S-5** | Split `circadian-runtime.ts` into four files, each keeping its rationale |
| **S-6** | A `TickingRegistry` for the two tick-driven managers, by composition |
| **S-7** | A shared target-set core and override tracker for the two tick-driven runtimes — well motivated, because H-3, H-5 and H-6 were each written twice |
| **S-8** | Extract the shared Flow reconciliation and give the verdicts one ranking. Half-built already in `lib/runtime/verdict.ts` |
| **S-9** | `event-normalizer.ts`: small cuts, and NOT a per-remote table |
| **S-10** | `canRamp`'s rotation arm describes a capability the runtime cannot exercise |
| **S-13** | Nothing per tick is worth moving to plan change |
| **S-14** | The driver layer: delete the dead copies, then a branch-free shell plus a testable recipe |
| **S-15** | `schedule-runtime.ts`: two pure moves |

## 5. Three questions only hardware can answer

Stated as questions because reading the code cannot settle them, and each one currently sits under a
guard written for the worst case:

1. **Hue's power-on event order** — which of `onoff`, `dim` and the colour axes a Hue bridge reports
   first when a lamp is switched back on at the wall.
2. **Whether `homey-api`'s socket reconnects by itself**, or whether a dropped connection leaves
   every subscription silently dead.
3. **What a `decimals: 1` lamp does with `dim 0.01`** — accept and round to zero, accept and clamp,
   or refuse.
