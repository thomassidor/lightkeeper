/**
 * The hardware pass's command line, parsed in one place.
 *
 * It used to be `argv.filter(a => !a.startsWith('--'))`, which was fine while
 * every flag was a bare switch. `--json <path>` takes a value, and under that
 * rule the path would have been read as a COMMAND — `Unknown command(s):
 * report.json`, or worse, a path that happened to spell one. So flags that take
 * a value are named here, and everything else is either a known switch or a
 * refusal.
 *
 * Pure, and exported so `test/unit/verify-hardware-logic.test.ts` can pin it:
 * running the script needs a Homey, parsing its arguments does not.
 */

/** Switches that take no value. */
const SWITCHES = new Set(['--yes', '--strict', '--house']);

/** Flags that take exactly one value, as `--json path` or `--json=path`. */
const VALUED = new Set(['--json']);

/**
 * @typedef {{
 *   commands: string[],
 *   yes: boolean,
 *   strict: boolean,
 *   house: boolean,
 *   json: string | null,
 *   errors: string[],
 * }} ParsedArgs
 */

/**
 * @param {readonly string[]} argv `process.argv.slice(2)`
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const parsed = {
    commands: [], yes: false, strict: false, house: false, json: null, errors: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);

    if (!argument.startsWith('--')) {
      parsed.commands.push(argument);
      continue;
    }

    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? null : argument.slice(equals + 1);

    if (SWITCHES.has(name)) {
      if (inline !== null) {
        parsed.errors.push(`${name} takes no value`);
        continue;
      }
      if (name === '--yes') parsed.yes = true;
      if (name === '--strict') parsed.strict = true;
      if (name === '--house') parsed.house = true;
      continue;
    }

    if (VALUED.has(name)) {
      // The next argument is the value, unless it is missing or is itself a
      // flag — `--json --yes` is a forgotten path, not a file called "--yes".
      const value = inline ?? argv[index + 1];
      if (value === undefined || value === '' || (inline === null && String(value).startsWith('--'))) {
        parsed.errors.push(`${name} needs a path, e.g. ${name} temp/verify.json`);
        continue;
      }
      if (inline === null) index += 1;
      if (name === '--json') parsed.json = String(value);
      continue;
    }

    parsed.errors.push(`unknown flag ${name}`);
  }

  return parsed;
}
