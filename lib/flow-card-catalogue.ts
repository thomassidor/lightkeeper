import type { HomeyApiService } from './homey-api-service';
import { titleTextOf, type CardToken, type DiscoveredTriggerCard } from './inputs/event-normalizer';
import type { CardArgument } from './inputs/magnitude-collapser';

/**
 * The ONE place in the app that reads a flow card catalogue, and the reason it
 * exists is memory (platform §15).
 *
 * `homey-api` caches every item returned by a `getAll` operation, permanently,
 * for the life of the client — see `Manager.__request`, where the `getAll`
 * branch writes `this.__cache` whenever `isConnected() && $updateCache`. Both
 * card catalogues are `getAll` operations, and `HomeyApiService.read()`
 * connects the flow manager, so the gate is open for every call we make.
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

export class FlowCardCatalogue {
  private readonly ttlMs: number;
  private readonly now: () => number;

  private readonly triggers: Cached<DiscoveredTriggerCard[]>;
  private readonly actions: Cached<ActionCardRef[]>;

  constructor(
    private readonly api: HomeyApiService,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.triggers = new Cached(this.now, this.ttlMs);
    this.actions = new Cached(this.now, this.ttlMs);
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
 * A value fetched at most once per TTL, and at most once at a time.
 *
 * The in-flight promise is retracted in `finally` — on failure as well as
 * success — for the same reason `HomeyApiService.read()` and
 * `DeviceCatalog.refresh()` do it: clearing only on the happy path caches a
 * rejection forever, and one transient failure at boot then poisons every
 * later call with nothing short of a restart to recover.
 */
class Cached<T> {
  private value: T | null = null;
  private at = 0;
  private inFlight: Promise<T> | null = null;

  constructor(private readonly now: () => number, private readonly ttlMs: number) {}

  async get(fetch: () => Promise<T>): Promise<T> {
    if (this.value !== null && this.now() - this.at < this.ttlMs) return this.value;
    if (this.inFlight) return this.inFlight;

    const attempt = fetch()
      .then(value => {
        this.value = value;
        this.at = this.now();
        return value;
      })
      .finally(() => {
        if (this.inFlight === attempt) this.inFlight = null;
      });

    this.inFlight = attempt;
    return attempt;
  }

  clear(): void {
    this.value = null;
    this.at = 0;
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
      name: a?.name,
      type: a?.type,
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
