import type { HomeyApiService } from './homey-api-service';
import { withDefaults, type Timers } from './support/timers';
import { titleTextOf, type CardToken, type DiscoveredTriggerCard } from './inputs/event-normalizer';
import type { CardArgument } from './inputs/magnitude-collapser';

/**
 * The ONE place in the app that reads a flow card catalogue, and the reason it
 * exists is memory (platform §15).
 *
 * `homey-api` caches every item returned by a `getAll` operation, permanently,
 * for the life of the client — see `Manager.__request`, where the `getAll`
 * branch writes `this.__cache` whenever `isConnected() && $updateCache`. Both
 * card catalogues are `getAll` operations. `HomeyApiService.read()` used to
 * connect the flow manager, which held that gate open for every call we made;
 * it no longer does (see `READ_MANAGERS`), but the opt-out below stays. It is
 * what keeps the rule true whichever client and whichever connect list a
 * future change hands this class, and it costs nothing.
 *
 * That is not a small cache. Platform §4 records ~1700 trigger cards on a real
 * Homey; measured, that payload is ~11.6 MB of JSON retaining ~16.8 MB of heap
 * once parsed, and the action catalogue is the same order again. The app read
 * both, used them for a handful of string comparisons, and then held ~30 MB
 * for the rest of its life — most of the 48 MB the profiler reported.
 *
 * So every fetch here passes `{ $cache: false, $updateCache: false }` — the
 * same opt-out `homey-api` uses internally in `ManagerDevices.scheduleRefresh`
 * — and the raw cards are projected down to the fields we actually read before
 * the array is dropped. The projection is ~1.1 MB for the same 1700 cards,
 * because it discards `titleFormatted`, `hint`, `iconObj`, `color` and every
 * non-English locale.
 *
 * What the discarded cache DID buy is replaced deliberately, not lost: a
 * single-flight promise plus a short TTL. `HealthMonitor.findReattachCandidate`
 * calls `discover()` once per plausible device in a loop, and only the
 * permanent cache stopped that becoming N full catalogue fetches.
 */

/** A card's identity, echoed back verbatim — never constructed (platform §3). */
export interface ActionCardRef {
  id: string;
  uri: string;
}

/** Long enough to cover a burst of discovery, short enough to never be stale. */
const DEFAULT_TTL_MS = 60_000;

/**
 * What one of the two catalogues has cost since the app started. For
 * `/diagnostics` only: counts, a duration and a size, never a card.
 *
 * The trigger catalogue is the expensive read in this app — every card of every
 * installed app, ~1.0-1.3 MB of JSON on the reference Homey (platform §15) —
 * and how often it happens is set by how often something asks, which nothing
 * recorded. These say it.
 */
export interface CatalogueReadStats {
  /** Reads that went to the Homey, successful or not. */
  fetches: number;
  failures: number;
  /** How long the last successful read took, fetch and projection together. */
  lastMs: number | null;
  /** How many cards the last successful read returned. */
  lastCount: number | null;
  /** Whether a projection is being held right now. */
  retained: boolean;
}

export interface CardCatalogueStats {
  triggers: CatalogueReadStats;
  actions: CatalogueReadStats;
}

export class FlowCardCatalogue {
  private readonly ttlMs: number;
  private readonly timers: Timers;

  private readonly triggers: Cached<DiscoveredTriggerCard[]>;
  private readonly actions: Cached<ActionCardRef[]>;

  /**
   * `now` alone is still accepted, as the older tests pass it; `timers` is
   * what drives the release timer as well.
   */
  constructor(
    private readonly api: HomeyApiService,
    options: { ttlMs?: number; now?: () => number; timers?: Partial<Timers> } = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timers = withDefaults({ ...options.timers, ...(options.now ? { now: options.now } : {}) });
    this.triggers = new Cached(this.timers, this.ttlMs);
    this.actions = new Cached(this.timers, this.ttlMs);
  }

  /** What the two catalogues have cost so far. See `CatalogueReadStats`. */
  stats(): CardCatalogueStats {
    return { triggers: this.triggers.stats(), actions: this.actions.stats() };
  }

  /**
   * Every trigger card on the Homey, projected to what the app reads of one.
   *
   * Deliberately the whole catalogue rather than a filtered slice: the Web API
   * offers no server-side filter, and device-scoped cards are matched on card
   * ID rather than URI (platform §4), so the caller has to see all of them.
   */
  async triggerCards(): Promise<DiscoveredTriggerCard[]> {
    return this.triggers.get(async () => {
      const raw = await this.fetch(client => client.flow.getFlowCardTriggers(NO_CACHE));
      // Projected inside the fetch, so the raw array is unreachable the moment
      // this returns. Assigning it to a field first — even briefly — is what
      // would put the 16.8 MB back.
      return raw.map(toDiscoveredCard);
    });
  }

  /**
   * ONE action card, asked for by name, WITHOUT reading the catalogue.
   *
   * This is the cheap path and it is the one that normally runs. The app only
   * ever needs its own three bridge cards, and reading ~1700 action cards to
   * find three of them is the single largest avoidable allocation the app
   * makes — and, since V8 never hands the pages back (platform §15), a peak
   * that is paid once and kept forever.
   *
   * It does NOT break platform §3's rule. What §3 forbids is inventing a
   * card's `uri` and using it: a card's uri is a full resource URI embedding
   * its own id, and a constructed one 404s in a way that reads like a
   * permission refusal. Here the OWNER uri — `homey:app:<appId>`, which is
   * this app's own identity and not a card's — addresses the request, and the
   * `id` and `uri` we go on to use are read back off whatever the Homey
   * returns. Nothing is assembled and then trusted.
   *
   * Returns null rather than throwing, because a miss is expected and
   * recoverable: an app's own cards exist only while that app is running
   * (§3), so a 404 here can mean "not registered yet". The caller falls back
   * to enumeration, which is the behaviour this replaced.
   */
  async actionCardRef(ownerUri: string, shortId: string): Promise<ActionCardRef | null> {
    try {
      const client = await this.api.read();
      const card = await client.flow.getFlowCardAction({ uri: ownerUri, id: shortId, ...NO_CACHE });
      const id = String(card?.id ?? '');
      const uri = String(card?.uri ?? '');
      return id && uri ? { id, uri } : null;
    } catch {
      // Not a transport verdict: a 404 is the Homey answering, and the caller
      // has a fallback that will report a real failure properly.
      return null;
    }
  }

  /**
   * Every action card's id and uri, and nothing else. The FALLBACK path.
   *
   * The caller matches on these itself: a card's uri embeds its own id and is
   * not `homey:app:<appId>`, so it must be enumerated and echoed rather than
   * constructed (platform §3).
   */
  async actionCardRefs(): Promise<ActionCardRef[]> {
    return this.actions.get(async () => {
      const raw = await this.fetch(client => client.flow.getFlowCardActions(NO_CACHE));
      return raw.map(card => ({ id: String(card?.id ?? ''), uri: String(card?.uri ?? '') }));
    });
  }

  /** Drop whatever is held. Called on teardown; also what makes tests explicit. */
  clear(): void {
    this.triggers.clear();
    this.actions.clear();
  }

  private async fetch(read: (client: any) => Promise<unknown>): Promise<any[]> {
    try {
      const client = await this.api.read();
      return Object.values(await read(client) as Record<string, any>);
    } catch (error) {
      // A socket that has gone away answers every later read identically. Say
      // so, and let the next call rebuild the client rather than every
      // discovery for the rest of the app run failing the same way.
      this.api.reportReadFailure(error);
      throw error;
    }
  }
}

/**
 * The opt-out, exported because every `getAll` call site in the app needs it.
 *
 * Both flags, not one: `$cache: false` alone still lets the response be WRITTEN
 * to `Manager.__cache`, which is the half that costs the memory. `homey-api`
 * uses this exact pair internally in `ManagerDevices.scheduleRefresh`.
 */
export const NO_CACHE = { $cache: false, $updateCache: false } as const;

/**
 * A value fetched at most once per TTL, and at most once at a time — and let go
 * when the TTL runs out.
 *
 * The in-flight promise is retracted in `finally` — on failure as well as
 * success — for the same reason `HomeyApiService.read()` and
 * `DeviceCatalog.refresh()` do it: clearing only on the happy path caches a
 * rejection forever, and one transient failure at boot then poisons every
 * later call with nothing short of a restart to recover.
 *
 * The release timer is the other half of the TTL. Expiry used to be checked
 * only on a read, so a projection outlived its TTL until the next read
 * replaced it: once anything had asked, ~1.1 MB of trigger cards (platform
 * §15's figure for 1700 cards) stayed on the heap for the whole app run,
 * however long ago the question was. The expiry check on read stays as well,
 * for a clock that moves without its timers firing. The timer is `unref`'d, so
 * it never holds a process open on its own, and `clear()` cancels it, because
 * nothing may outlive the teardown that calls it.
 */
class Cached<T> {
  private value: T | null = null;
  private at = 0;
  private inFlight: Promise<T> | null = null;
  private release: unknown = null;
  /**
   * Bumped by `clear()`. A fetch that was already in flight when `clear()` ran
   * still answers its own caller, but may not store its result or arm a
   * release timer: on teardown that re-retained a whole projection and left a
   * timer armed after everything was meant to be gone.
   */
  private generation = 0;
  private readonly counts: Omit<CatalogueReadStats, 'retained'> = {
    fetches: 0, failures: 0, lastMs: null, lastCount: null,
  };

  constructor(private readonly timers: Timers, private readonly ttlMs: number) {}

  async get(fetch: () => Promise<T>): Promise<T> {
    if (this.value !== null && this.timers.now() - this.at < this.ttlMs) return this.value;
    if (this.inFlight) return this.inFlight;

    const startedAt = this.timers.now();
    const generation = this.generation;
    this.counts.fetches += 1;
    const attempt = fetch()
      .then(value => {
        if (generation !== this.generation) return value;
        this.value = value;
        this.at = this.timers.now();
        this.counts.lastMs = this.at - startedAt;
        this.counts.lastCount = Array.isArray(value) ? value.length : null;
        this.armRelease();
        return value;
      }, (error: unknown) => {
        this.counts.failures += 1;
        throw error;
      })
      .finally(() => {
        if (this.inFlight === attempt) this.inFlight = null;
      });

    this.inFlight = attempt;
    return attempt;
  }

  stats(): CatalogueReadStats {
    return { ...this.counts, retained: this.value !== null };
  }

  clear(): void {
    this.generation += 1;
    this.cancelRelease();
    this.value = null;
    this.at = 0;
    // Not joined by the next `get()` either: that would hand a later caller
    // the very read this call was meant to let go of.
    this.inFlight = null;
  }

  private armRelease(): void {
    this.cancelRelease();
    this.release = this.timers.setTimeout(() => {
      this.release = null;
      this.value = null;
      this.at = 0;
    }, this.ttlMs);
    (this.release as { unref?: () => void } | null)?.unref?.();
  }

  private cancelRelease(): void {
    if (this.release === null) return;
    this.timers.clearTimeout(this.release);
    this.release = null;
  }
}

/**
 * One raw card, reduced to the fields the app reads.
 *
 * Titles are flattened to English HERE rather than downstream. The app ships
 * English only, and a card's `title` arrives as a locale object carrying every
 * language the integration was translated into — which is the single largest
 * part of the payload. `titleTextOf` accepts either form, so nothing
 * downstream changes, and the fingerprints stay byte-identical because they
 * pass titles through the same flattening before hashing.
 */
export function toDiscoveredCard(card: any): DiscoveredTriggerCard {
  const id = String(card?.id ?? '');
  const shortId = id.startsWith('homey:device:') ? id.split(':').slice(3).join(':') : id;
  return {
    id,
    shortId,
    uri: String(card?.uri ?? ''),
    title: titleTextOf(card?.title) ?? shortId,
    args: ((card?.args ?? []) as any[]).map((a): CardArgument => ({
      // Coerced, like every sibling field here and like the tokens below.
      // `CardArgument.name` is declared `string`, and this assigned whatever the
      // card had — `undefined` for an argument with no name. The fingerprint
      // builder sorts on it (`a.name.localeCompare(b.name)` in
      // source-discovery-service.ts), so one third-party trigger card with two
      // arguments and a nameless one threw a TypeError inside `discover()` — the
      // remote picker, the re-attach scan and the reconcile path, for the whole
      // Homey.
      name: String(a?.name ?? ''),
      type: String(a?.type ?? ''),
      values: (a?.values as any[] | undefined)?.map(v => ({
        id: String(v?.id),
        title: titleTextOf(v?.title) ?? undefined,
      })),
      filter: a?.filter,
      min: a?.min,
      max: a?.max,
      step: a?.step,
    })),
    tokens: ((card?.tokens ?? []) as any[]).map((t): CardToken => ({
      id: String(t?.id ?? ''),
      type: String(t?.type ?? ''),
      // The title carries the scale, e.g. "Steps (1000/turn)".
      title: titleTextOf(t?.title) ?? undefined,
    })),
  };
}
