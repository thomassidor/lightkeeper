/**
 * What the app can learn about its own memory from INSIDE the sandbox.
 *
 * Platform §15 left this as the one missing signal. `apps.getAppUsage`'s `pss`
 * is readable from outside and is what `scripts/verify-hardware.mjs memory`
 * reports, but it cannot separate the two things that matter: holding a parsed
 * catalogue and merely having parsed one cost the same RSS, because V8 never
 * returns the pages. `used_heap_size` CAN separate them — a few MB when the
 * catalogue is let go, ~17 MB higher when it is not — so exposing it is what
 * turns T59 from a smoke check into something that can localise a regression.
 *
 * Platform §17 is why every reading here is individually guarded rather than
 * assembled in one literal. `process.memoryUsage()` throws
 * `ENOENT: uv_resident_set_memory` in this sandbox, and the last time a memory
 * call went bare into an object literal it took the whole health sample with
 * it — the timezone, the sensor ages, the credential status — once per sample
 * for a week. A throwing reading here must cost its own field and nothing else.
 *
 * `v8.getHeapStatistics()` does not read `/proc`: it asks V8 for numbers V8
 * already has, which is why it survives where the resident-set read does not.
 * `process.resourceUsage()` goes to `getrusage(2)` rather than `/proc` and is
 * tried on the same reasoning — but it is tried, not assumed.
 */

/** Every field null-able, because each is read behind its own guard. */
export interface HeapReport {
  /** V8's own accounting, in bytes. The signal that separates retention from peak. */
  heapUsed: number | null;
  heapTotal: number | null;
  /** The ceiling V8 will not grow past — context for the two above. */
  heapLimit: number | null;
  /** Buffers and other off-heap allocations V8 knows about. */
  external: number | null;
  /** Native allocation V8 is holding, and the most it has ever held. */
  malloced: number | null;
  peakMalloced: number | null;
  /**
   * Used bytes per V8 heap space, largest first.
   *
   * This is the field that says WHICH KIND of growth happened. `old_space`
   * growing is retained data — a cache that was not dropped. `code_space` and
   * `large_object_space` growing are compiled JS and single allocations over
   * V8's large-object threshold, which is where a multi-megabyte JSON parse
   * lands. Without the split, `heapUsed` alone cannot tell a leak from a parse.
   */
  spaces: Record<string, number> | null;
  /**
   * Resident set size in bytes, read straight out of `/proc/self/statm`.
   *
   * Platform §17 established that `process.memoryUsage()` throws
   * `ENOENT: uv_resident_set_memory` in this sandbox, and concluded the app
   * could not see its own RSS. That conclusion was about libuv's reader, not
   * about `/proc` — so this tries the file itself. If it answers, the app can
   * finally attribute its own footprint from the inside instead of inferring it
   * from `apps.getAppUsage` minutes later and from outside.
   */
  rss: number | null;
  /**
   * getrusage's high-water mark. Reported, but read the docblock before
   * believing it: it is IDENTICAL across app restarts and reinstalls (105.3 MB
   * on three different process lifetimes), which means it is inherited from the
   * app-runner parent rather than reset for this process. `maxRSS` survives
   * `fork()` and is only cleared by `exec()`, so a Homey that forks its app
   * workers hands every one of them the parent's high-water mark. It says
   * nothing about this app.
   */
  maxRss: number | null;
  /** Seconds since this app process started. Distinguishes a boot from a settled run. */
  uptimeSeconds: number | null;
  /** Which readings were refused, and how. Empty on a Homey that answers all of them. */
  unavailable: string[];
  /**
   * Where the footprint was already at, at each named point in boot.
   *
   * The question these answer is the one `apps.getAppUsage` cannot: how much of
   * the app's resident memory is set before its own `onInit` does anything.
   * A floor that is already high at `modules-loaded` is the cost of requiring
   * the app's ~100 modules plus the SDK, and no amount of care with caches will
   * move it; one that climbs during `onInit` is ours to attribute.
   */
  marks: Array<{ phase: string; atMs: number; heapUsed: number | null; rss: number | null }>;
}

/**
 * Boot marks, module-level because they must outlive any one request.
 *
 * Bounded by the number of `markPhase` call sites, which is three — this is a
 * fixed set of named points, never a log. Anything that appends per event
 * belongs in a `BoundedLog`, not here.
 */
const marks: HeapReport['marks'] = [];

/** Record where memory stood at a named point in boot. Never throws. */
export function markPhase(phase: string): void {
  try {
    const reading = heapReport();
    marks.push({ phase, atMs: Date.now(), heapUsed: reading.heapUsed, rss: reading.rss });
  } catch { /* a mark is diagnostics; it must never be able to fail a boot */ }
}

/**
 * One reading of everything that will answer, and nothing that will not.
 *
 * Never throws. A caller putting this in a response literal is exactly the
 * shape §17 warns about, so the guarding is this function's responsibility
 * rather than its callers'.
 */
export function heapReport(): HeapReport {
  const unavailable: string[] = [];

  const stats = attempt('v8.getHeapStatistics', unavailable, () => {
    // Required lazily: `v8` is a core module, but a require at module scope in
    // a file the pairing rigs import would run it on every test process too.
    const v8 = require('node:v8');
    return v8.getHeapStatistics() as Record<string, number>;
  });

  const spaces = attempt('v8.getHeapSpaceStatistics', unavailable, () => {
    const v8 = require('node:v8');
    const out: Record<string, number> = {};
    for (const space of v8.getHeapSpaceStatistics() as Array<{ space_name: string; space_used_size: number }>) {
      // Empty spaces are noise in a report meant to be read at a glance.
      if (space.space_used_size > 0) out[space.space_name] = space.space_used_size;
    }
    return out;
  });

  const statm = attempt('/proc/self/statm', unavailable, () => {
    const { readFileSync } = require('node:fs');
    // `size resident shared text lib data dt`, in PAGES. Only the second is
    // wanted, and a page is 4096 bytes on every platform Homey ships on.
    const fields = String(readFileSync('/proc/self/statm', 'utf8')).trim().split(/\s+/);
    const pages = Number(fields[1]);
    return Number.isFinite(pages) ? pages * 4096 : null;
  });

  const rusage = attempt('process.resourceUsage', unavailable, () => process.resourceUsage());
  const uptime = attempt('process.uptime', unavailable, () => process.uptime());

  return {
    heapUsed: finite(stats?.used_heap_size),
    heapTotal: finite(stats?.total_heap_size),
    heapLimit: finite(stats?.heap_size_limit),
    external: finite(stats?.external_memory),
    malloced: finite(stats?.malloced_memory),
    peakMalloced: finite(stats?.peak_malloced_memory),
    spaces: spaces ?? null,
    // getrusage reports maxRSS in KILObytes on Linux; normalise to bytes so
    // every number in this report has one unit.
    rss: statm ?? null,
    maxRss: rusage?.maxRSS === undefined ? null : finite(rusage.maxRSS * 1024),
    uptimeSeconds: uptime === undefined ? null : finite(Math.round(uptime)),
    unavailable,
    marks: [...marks],
  };
}

function attempt<T>(name: string, unavailable: string[], read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    // The MESSAGE, not just the name: `ENOENT: no such file or directory,
    // uv_resident_set_memory` is the line that told us what the sandbox was
    // actually refusing, and a bare "unavailable" would have sent the next
    // reader looking at permissions.
    unavailable.push(`${name}: ${String((error as { message?: unknown })?.message ?? error)}`);
    return undefined;
  }
}

/** A number, or null — never NaN, and never a string that looks like one. */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
