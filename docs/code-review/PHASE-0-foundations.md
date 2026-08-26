# Phase 0 — Foundations: lint, test kit, support primitives, CI hardening

**Goal:** Put the tooling and shared primitives in place that every later phase leans on, without changing runtime behaviour.
**Findings:** Q3 (no linter), S3 (CI supply chain), and the enabling halves of B10 (`fireAndForget`), D5 (`Timers`), D6 (`BoundedLog`), B22 (`KeyedMutex`).
**Behaviour change allowed in this phase:** none. Every task here is additive. All 411 existing tests must pass unmodified (except where a test imports a moved helper — none should).

---

## Task 0.1 — `lib/support/` primitives

Create `lib/support/` with four small, fully unit-tested modules. These are consumed by later phases; in *this* phase, wire in only the zero-risk call sites listed.

**0.1a `lib/support/async.ts`** — `fireAndForget(promise: Promise<unknown>, log: (...args: unknown[]) => void, label: string): void`. Attaches `.catch(err => log(\`\${label} failed:\`, (err as Error)?.message))`. Nothing else — no retry, no queue.
- Wire in now (mechanical, zero behaviour change): every `void <asyncCall>(...)` site in `app.ts`, `lib/runtime/controller-runtime.ts` (`void this.execute(input)` in the gate callback, `void this.runIntent(...)` in the ramp tick), `lib/schedules/schedule-runtime.ts` (`void this.apply(...)`), `lib/circadian/circadian-runtime.ts` (`void this.applyNow(...)`), and the three managers' catalog-change inner IIFEs. Keep the semantics identical: still fire-and-forget, now with a rejection handler and a label.
- Test: a rejecting promise is logged with its label; a resolving one logs nothing.

**0.1b `lib/support/bounded-log.ts`** — `class BoundedLog<T>` with `add(entry: T): void`, `entries(): readonly T[]` (**newest-first, always**), constructor cap. ~15 lines.
- Wire in now: `app.ts` `recentEvents` (cap 40), `LightTargetAdapter.recentWrites` (cap 30), `LightTargetAdapter.recentFailures` (cap 50). **Note:** `recentFailures` currently runs oldest-first (`push`+`shift`); switching it to newest-first is a deliberate consistency fix — update `test/unit/diagnostics-redaction.test.ts` and any test asserting failure order, and note the change in the commit message.
- Test: cap enforcement, newest-first ordering.

**0.1c `lib/support/timers.ts`** — `interface Timers { setTimeout; clearTimeout; setInterval; clearInterval; now(): number }`, `const realTimers: Timers`, `withDefaults(partial?: Partial<Timers>): Timers`.
- Do **not** migrate `CommandScheduler`/`RampEngine`/`SupersedeGate`/circadian call sites yet (that churn belongs to the phases that touch those files — 2 and 6). This task only creates and tests the module so later phases share one shape.

**0.1d `lib/support/keyed-mutex.ts`** — `class KeyedMutex` with `run<T>(key: string, fn: () => Promise<T>): Promise<T>` (per-key FIFO) and `class SingleFlight` with `coalesce<T>(key: string, fn: () => Promise<T>): Promise<T>` semantics documented as: if a run is in flight for `key`, remember that a re-run was requested and run `fn` once more after the current one completes (latest-state coalescing, not promise sharing — reconciliation must re-run against *new* desired state, not return the stale in-flight result).
- Tests: FIFO ordering under interleaving (use deferred promises from 0.2); coalescing runs at most one trailing re-run for N overlapping requests.

## Task 0.2 — Test kit: `test/support/`

**0.2a `test/support/deferred.ts`** — `deferred<T>()` returning `{ promise, resolve, reject }`.
**0.2b `test/support/fake-timers.ts`** — a manual-advance implementation of the `Timers` interface (`advance(ms)`, pending-count), compatible with the existing injectable `setTimeout`/`now` options on `CommandScheduler`, `RampEngine`, `SupersedeGate`.
**0.2c `test/support/failing-nth.ts`** — `failNth<T>(fn, n, error)` wrapper: passes calls through, rejects the Nth. Used heavily in Phases 1–3.
- Tests for the helpers themselves (brief).

## Task 0.3 — ESLint

- Add flat config (`eslint.config.mjs`) with `typescript-eslint` **type-checked** recommended; enable as *errors*: `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`. Scope: `app.ts`, `api.ts`, `lib/**`, `drivers/**/*.ts`, `scripts/**`, `test/**`.
- After Task 0.1a, `no-floating-promises` should be nearly clean. For any residual intentional fire-and-forget (there should be none once `fireAndForget` is wired), use a line disable with a reason comment — never a file/global disable.
- Delete the now-honoured stray directive in `lib/homey-api-service.ts` if the rule set doesn't require it, or keep it with the correct rule name if it does.
- Add `"lint": "eslint ."` to package.json scripts.
- **Do not** add a formatter in this phase (Prettier reformat = 10k-line diff that buries every later review; parked as an explicit non-goal).

## Task 0.4 — CI hardening

In `.github/workflows/ci.yml`:
- Pin `actions/checkout` and `actions/setup-node` to full commit SHAs, with the tag in a trailing comment.
- Add a `Lint` step (`npm run lint`) after type-checks.
- Move the Homey CLI into `devDependencies` at exactly `4.4.2`; change the `validate` script to `homey app validate --level publish` (runs from the lockfile). Keep the existing app.json drift check and the deliberate absence of `sync:views` in CI (its comment explains why — preserve it).
- Add a Dependabot config for npm + github-actions (weekly).

## Task 0.5 — Safety-promise test scaffolding (R1 groundwork)

- Create `test/unit/safety-promises.test.ts` with a documented convention: one named test per explicit README/CLAUDE.md safety promise. Seed it with the two promises that are already true and cheap to assert (e.g., "deleting a device removes only flows carrying its id in our bridge args" can be asserted against `removeAll` behaviour with a fixture; "a renamed flow is reused in place" against `hasBeenUserEdited`). Later phases add their promises here as they fix them (each phase file says which).
- Add a tiny test that greps `CLAUDE.md` for every `§n` referenced from `lib/**` and asserts the section exists (the review found these references are load-bearing).

## Exit criteria

- `npm run lint` passes and runs in CI; actions SHA-pinned; Homey CLI lockfile-installed.
- `lib/support/` and `test/support/` exist with their own passing tests.
- All pre-existing tests pass; the only intentional behavioural delta is `recentFailures` ordering (documented in the commit).
- No `void <promise>` expression remains outside `fireAndForget` (lint enforces it from here on).
