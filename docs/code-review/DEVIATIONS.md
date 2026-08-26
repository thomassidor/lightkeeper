# Deviations from the remediation plan

Where the plan and the code disagreed, and what was done instead. Per the
master plan's rule 6: a discrepancy is recorded rather than improvised around.

---

## Phase 0

### 0.3 — `no-unnecessary-type-assertion` is OFF, not on

**Plan:** flat config with `typescript-eslint` type-checked recommended, three
named rules as errors.

**What happened:** the recommended set brings `no-unnecessary-type-assertion`,
which reported 116 sites. Its `--fix` broke the build. Four of the removals were
`Object.values(await client.flow.getFlowCardTriggers()) as any[]` — homey-api's
untyped return makes those `unknown[]`, the assertion widens them to `any[]`,
and the rule read "an assertion to `any`" as "an assertion that changes
nothing". At the one boundary this codebase deliberately uses `any`, the rule is
wrong and its autofix is destructive.

**Decision:** rule off, with that reasoning in `eslint.config.mjs`. The
remaining 112 sites were reverted along with it — a mechanical edit whose
mechanism has been shown to be unsound is not a safe mechanical edit.

### 0.3 — three rules relaxed from the recommended defaults, each for a reason

| Rule | Setting | Why |
|---|---|---|
| `no-misused-promises` | `checksVoidReturn.inheritedMethods: false` | `@types/homey` declares `Device.onRenamed`/`onDeleted` as returning `void`; the SDK genuinely awaits them. The community types are wrong and the async overrides are right. Every other misuse still errors. |
| `switch-exhaustiveness-check` | `considerDefaultExhaustiveForUnions: true` | Two switches (`credentialFailureKey`, `semanticClass`) are total by construction via a deliberate `default:`. The rule still catches a defaultless switch missing a variant, which is the failure it exists for. |
| `require-await` | off | Several methods are `async` because their signature is a contract callers await (`onCatalogChange`, `runIntent`), not because the body currently needs one. Dropping `async` would make adding the first `await` a breaking signature change. |

`no-floating-promises` uses `allowForKnownSafeCalls` for `node:test`'s `test`,
`describe` and `it` — 517 call sites where the RUNNER owns the promise. Nothing
else has an escape hatch: there is no remaining `void <promise>` in the repo.

### 0.4 — the Homey CLI as a devDependency worsens `npm audit`, and that is fine

Moving `homey@4.4.2` out of `npx --yes` and into `devDependencies` takes the
audit from 4 moderate to 17 findings (2 low, 10 moderate, 5 high — `sharp` and
`libvips`). **`npm audit --omit=dev` is unchanged: exactly the four accepted
moderates through `homey-api`.** devDependencies are not bundled into a Homey
app, so nothing new ships. CLAUDE.md's audit note has been amended to say which
tree it is talking about.

The gain is real: `npx --yes homey@4.4.2` pins the CLI but not its transitive
tree, so "publish-level valid" still drifted between two runs of one commit.

### 0.1c — `Timers` members are declared `this: void`

Not in the plan, but required: the interface's members are routinely passed on
as bare functions (a `FakeTimers.setTimeout` handed to a class that still takes
the old piecemeal options), so none may depend on its receiver.
`unbound-method` catches this, correctly.

### 0.5 — test files use `describe` + `test`, never `t.test`

`test/unit/release-metadata.test.ts` counts tests by grepping for `test(` at a
word boundary, and README.md quotes that count. A nested `await t.test(...)`
runs but is not counted, so the two numbers diverge silently. New suites follow
the repo's existing `describe(...)` + `test(...)` shape.
