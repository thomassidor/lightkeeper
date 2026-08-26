// @ts-check
import tseslint from 'typescript-eslint';

/**
 * The rule set is deliberately narrow.
 *
 * This is not a style linter — there is no formatter here on purpose (a
 * Prettier pass would be a ten-thousand-line diff that buries every review for
 * a release). What it enforces is the small set of mistakes this codebase has
 * actually made and that type-checking alone does not catch:
 *
 *   no-floating-promises   an unawaited reconcile whose rejection vanishes.
 *                          Every deliberate fire-and-forget goes through
 *                          lib/support/async.ts, which is a call, not a `void`.
 *   no-misused-promises    an async function passed where a void callback is
 *                          expected — a listener that "handles" an error into
 *                          nowhere.
 *   switch-exhaustiveness  the discriminated unions (intents, bindings,
 *                          anchors, write outcomes) are how new variants are
 *                          added; a switch that silently skips one is the
 *                          failure mode CLAUDE.md §12's anchor union exists to
 *                          prevent.
 *
 * Type-checked linting means the config needs a project, hence the two
 * language-options blocks: the app is CommonJS on @tsconfig/node16, the suite
 * and scripts are ESM.
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.homeybuild/**',
      'app.json',
      // Neither tsconfig includes this file, and type-checked rules need a
      // project. It is 100 lines of config, checked by `// @ts-check` above.
      '**/*.js',
      '**/*.mjs',
    ],
  },

  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Both projects, so every file the linter is scoped to has type
        // information. Without this the type-checked rules silently downgrade.
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `test()` and `describe()` from node:test return a promise the RUNNER
      // owns — the suite's own idiom, 500-odd call sites of it. Everything
      // else, in app code and tests alike, must be awaited or go through
      // lib/support/async.ts. There is no `void` escape hatch left.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [
          { from: 'package', package: 'node:test', name: ['test', 'describe', 'it'] },
        ],
      }],

      // `inheritedMethods: false` because of @types/homey, not because of us:
      // it declares Device.onRenamed/onDeleted/onUninit as returning void,
      // while the SDK genuinely awaits them (a synchronous onDeleted would
      // orphan the flows it is there to remove). The community types are wrong
      // here and the async overrides are right; every other misuse still errors.
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: { inheritedMethods: false },
      }],

      // A `default:` that returns a sensible value for the rest of a union is
      // a deliberate design in two places here (the credential failure-key map
      // and the normalizer's semantic classes) — both are total by
      // construction. What the rule must still catch is a switch with NO
      // default that silently skips a new variant.
      '@typescript-eslint/switch-exhaustiveness-check': ['error', {
        considerDefaultExhaustiveForUnions: true,
      }],

      // OFF, and this one was earned rather than assumed. Its --fix removed
      // `as any[]` from four `Object.values(await client.flow.getX())` calls
      // and broke the build: homey-api's untyped return makes those
      // `unknown[]`, the assertion widens them to `any[]`, and the rule read
      // "assertion to any" as "assertion that changes nothing". At the one
      // boundary this codebase deliberately uses `any` (see below), the rule
      // is not merely noisy — it is wrong, and its autofix is destructive.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',

      // A method is `async` here because its CALLERS await it and its
      // signature is part of a contract (onCatalogChange, runIntent), not
      // because its current body happens to need one. Dropping `async` would
      // make adding the first await a breaking signature change.
      '@typescript-eslint/require-await': 'off',

      // `any` at the Homey API boundary is a documented decision, not an
      // oversight: homey-api ships JavaScript with JSDoc and no declarations,
      // so every client call is untyped at the seam. Everything of ours is
      // strict. Turning these on would mean hundreds of suppressions at the
      // exact boundary where the suppression carries no information.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',

      // Template literals carry ids, capability values and error messages from
      // that same untyped boundary; stringifying them is the point.
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-base-to-string': 'off',

      // `error: unknown` narrowed with `(error as Error)?.message` is the
      // repo's established idiom and is safer than what these would suggest.
      '@typescript-eslint/no-unnecessary-condition': 'off',

      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],

      // require() is how homey-api is loaded (see lib/homey-api-service.ts).
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  /**
   * `lib/` is ours, so `any` is a decision that has to be argued for.
   *
   * The listed files are the SEAMS: the two places `homey-api`'s untyped client
   * is held, the normalisers that read its raw objects, and the device layer's
   * `homey.app` / `getData()` boundary — which is the Homey SDK's own untyped
   * surface, not ours. `lib/homey-api-types.ts` is what a normaliser should be
   * reaching for instead of a fresh `any`.
   *
   * The rest of the family (`no-unsafe-assignment` and friends) stays off above:
   * those fire on every USE of a value that crossed a seam, which is most of the
   * app. This one fires only where the word is written, which is where the
   * decision is being made.
   */
  {
    files: ['lib/**/*.ts'],
    ignores: [
      // The two clients themselves.
      'lib/homey-api-service.ts',
      'lib/credential-service.ts',
      // Normalisers reading raw client objects.
      'lib/bridge/flow-bridge-manager.ts',
      'lib/bridge/flow-folder-manager.ts',
      'lib/device-catalog.ts',
      'lib/source-discovery-service.ts',
      'lib/schedules/time-card-discovery.ts',
      'lib/outputs/light-target-adapter.ts',
      'lib/pairing/target-picker.ts',
      // The Homey SDK's own untyped device surface.
      'lib/devices/lightkeeper-device.ts',
      'lib/devices/device-lifecycle.ts',
      // A generic FIFO whose resolvers are genuinely of any type.
      'lib/support/keyed-mutex.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  {
    // The suite reaches into privates and builds deliberately malformed
    // fixtures; assertions about untrusted input are the subject matter.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      // A test that asserts on a non-Error rejection is asserting on exactly
      // the thing this rule wants to prevent.
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
    },
  },
);
