import { createHash } from 'node:crypto';

import type { HomeyApiService } from './homey-api-service';
import type { CatalogDevice } from './device-catalog';
import {
  normalizeCards,
  type DiscoveredTriggerCard,
} from './inputs/event-normalizer';
import type { SelectableInput } from './inputs/selectable-input';

/**
 * Discovery order, corrected against what the platform actually
 * exposes (see platform §4).
 *
 * Device-scoped trigger cards encode their device in the card ID:
 *     homey:device:<deviceId>:<cardName>
 * NO card carries a uri of `homey:device:<deviceId>`, so matching on uri — the
 * obvious reading — finds nothing and makes every remote look
 * eventless.
 *
 * Capability inspection is interface-only: no device tested so far
 * exposes input as a capability change. The seam exists so adding one
 * is additive rather than structural.
 */

export type MatchRoute = 'device_scoped' | 'device_arg' | 'device_arg_unfiltered';

export interface RankedSource {
  device: CatalogDevice;
  /** Input-like device-scoped cards. Zero means it cannot be a controller. */
  eventCount: number;
}

export interface DiscoveryResult {
  device: CatalogDevice;
  inputs: SelectableInput[];
  /** Cards declined, with why — surfaced in diagnostics only. */
  rejected: Array<{ cardId: string; reason: string }>;
  /** What makes repair safe after an integration update. */
  fingerprint: string;
  /**
   * The wider fingerprint, compared only by profiles that carry one.
   *
   * See `fingerprintV2Of`: adopting it unconditionally would mass-repair every
   * installed controller on upgrade, because v1 deliberately hashes less.
   */
  fingerprintV2: string;
  matchRoutes: MatchRoute[];
  cardsInspected: number;
}

export class SourceDiscoveryService {
  constructor(private readonly api: HomeyApiService) {}

  async discover(device: CatalogDevice): Promise<DiscoveryResult> {
    const client = await this.api.read();
    const allCards = Object.values(await client.flow.getFlowCardTriggers()) as any[];

    const matched: Array<{ card: DiscoveredTriggerCard; routes: MatchRoute[] }> = [];
    /** Cards a filter we cannot evaluate kept out. Reported, never guessed at. */
    const unevaluable: Array<{ cardId: string; reason: string }> = [];

    for (const card of allCards) {
      const { routes, declined } = matchRoutesFor(card, device);
      for (const reason of declined) {
        unevaluable.push({ cardId: String(card?.id ?? '?'), reason });
      }
      if (routes.length === 0) continue;
      matched.push({ card: toDiscoveredCard(card), routes });
    }

    // Strong matches only reach the picker. An unfiltered device argument
    // accepts every device on the Homey — it once offered "refrigerator error
    // changed" as an input for a dial. Never ranked into the catalogue, but the
    // rule is rank-last, not hard-filter: they are reported as declined below,
    // which is what makes "my remote shows no events" answerable.
    const strong = matched.filter(m =>
      m.routes.includes('device_scoped') || m.routes.includes('device_arg'));

    const { inputs, rejected } = normalizeCards(strong.map(m => m.card), {
      sourceDeviceId: device.id,
    });

    const weak = matched
      .filter(m => !strong.includes(m))
      .map(m => ({
        cardId: m.card.id,
        reason: 'matched only on an unfiltered device argument, which accepts every device',
      }));

    return {
      device,
      inputs,
      rejected: [...rejected, ...weak, ...unevaluable],
      fingerprint: fingerprintOf(device, strong.map(m => m.card)),
      fingerprintV2: fingerprintV2Of(device, strong.map(m => m.card)),
      matchRoutes: [...new Set(strong.flatMap(m => m.routes))],
      cardsInspected: allCards.length,
    };
  }

  /**
   * Rank plausible sources first, never hard-filter. A device with no
   * discoverable events must still be selectable, so the user sees "no usable
   * remote events found" rather than an unexplained absence.
   */
  async rankSources(devices: CatalogDevice[]): Promise<RankedSource[]> {
    const client = await this.api.read();
    const allCards = Object.values(await client.flow.getFlowCardTriggers()) as any[];

    const scopedCount = new Map<string, number>();
    for (const card of allCards) {
      const deviceId = deviceIdOfScopedCard(String(card.id ?? ''));
      if (!deviceId) continue;
      const shortId = String(card.id).split(':').slice(3).join(':');
      // Capability cards are not input; counting them would rank a thermometer
      // above a remote.
      if (/^(measure_|alarm_|meter_)|_threshold_|_changed$|_duration$/.test(shortId)) continue;
      scopedCount.set(deviceId, (scopedCount.get(deviceId) ?? 0) + 1);
    }

    return [...devices]
      .map(device => ({ device, eventCount: scopedCount.get(device.id) ?? 0 }))
      .sort((a, b) => {
        const byEvents = b.eventCount - a.eventCount;
        if (byEvents !== 0) return byEvents;
        const byRemoteish = remoteScore(b.device) - remoteScore(a.device);
        if (byRemoteish !== 0) return byRemoteish;
        return a.device.name.localeCompare(b.device.name);
      });
  }
}

function remoteScore(device: CatalogDevice): number {
  if (['button', 'remote'].includes(device.class)) return 2;
  if (device.class === 'light' || device.capabilities.includes('onoff')) return -2;
  return 0;
}

/**
 * Extract the device id from a device-scoped card id.
 *
 * Device cards are identified by ID (`homey:device:<id>:<card>`), never
 * by uri — no card carries a uri of `homey:device:<id>`, so matching on uri
 * finds nothing and makes every remote look eventless.
 */
export function deviceIdOfScopedCard(cardId: string): string | null {
  const match = /^homey:device:([^:]+):/.exec(cardId);
  return match?.[1] ?? null;
}

/**
 * Every way this card can be bound to this device. Empty means no route, and
 * the card is not offered for this device.
 */
function matchRoutesFor(
  card: any,
  device: CatalogDevice,
): { routes: MatchRoute[]; declined: string[] } {
  const routes: MatchRoute[] = [];
  const declined: string[] = [];

  if (deviceIdOfScopedCard(String(card.id ?? '')) === device.id) {
    routes.push('device_scoped');
  }

  for (const arg of (card.args ?? []) as any[]) {
    if (arg?.type !== 'device') continue;
    const verdict = deviceMatchesFilter(arg.filter, device);
    if (verdict.unknownKeys.length > 0) {
      declined.push(
        `argument "${String(arg?.name ?? '?')}" filters on ${verdict.unknownKeys.join(', ')}, `
        + 'which this app cannot evaluate',
      );
      continue;
    }
    if (!verdict.matches) continue;
    routes.push(arg.filter ? 'device_arg' : 'device_arg_unfiltered');
  }

  // Deliberately NOT matching on "same owning app": it offered Hue
  // motion-area triggers as buttons on a Hue dial.
  return { routes, declined };
}

/**
 * Whether a device satisfies a card argument's `filter` query string.
 *
 * An absent or empty filter accepts everything — that is the SDK's own
 * semantics, and it is why 'device_arg_unfiltered' is tracked as a weaker
 * route than a filtered match.
 *
 * A key we do not understand is NOT ignored. Ignoring it read as "the filter
 * does not restrict on that", which is the opposite of what a filter is: an
 * unrecognised restriction we cannot evaluate means we cannot say this card
 * belongs to this device, and offering it anyway is how a Tap Dial was offered
 * "LG refrigerator error changed" as an input. The caller reports it as declined
 * with the key named, so "my remote shows no events" stays answerable — which is
 * the concern the old ignore-and-carry-on was protecting, kept without the guess.
 */
function deviceMatchesFilter(
  filter: unknown,
  device: CatalogDevice,
): { matches: boolean; unknownKeys: string[] } {
  if (filter === undefined || filter === null || filter === '') {
    return { matches: true, unknownKeys: [] };
  }
  if (typeof filter !== 'string') return { matches: false, unknownKeys: [] };

  const unknownKeys: string[] = [];
  const params = new URLSearchParams(filter);
  for (const [key, expected] of params.entries()) {
    switch (key) {
      case 'driver_id': {
        const driverId = String(device.driverId ?? '');
        if (driverId !== expected && (driverId.split(':').pop() ?? '') !== expected) {
          return { matches: false, unknownKeys: [] };
        }
        break;
      }
      case 'driver_uri': {
        /**
         * Matched on a SEGMENT boundary, not with a bare `startsWith`.
         *
         * A driver URI is `homey:app:<appId>` and a device's `driverId` is that
         * plus `:<driverName>`. A prefix test alone also accepts a truncated
         * app id — `homey:app:com.ikea.tra` matches `com.ikea.tradfri` — so a
         * filter naming one integration could pull in another whose id happens
         * to start the same way.
         */
        const driverId = String(device.driverId ?? '');
        const ownerUri = String(device.ownerUri ?? '');
        const exact = ownerUri === expected || driverId === expected;
        if (!exact && !driverId.startsWith(`${expected}:`)) {
          return { matches: false, unknownKeys: [] };
        }
        break;
      }
      case 'class': {
        const classes = expected.split('|');
        if (!classes.includes(device.class) && !classes.includes(device.virtualClass ?? '')) {
          return { matches: false, unknownKeys: [] };
        }
        break;
      }
      case 'capabilities': {
        const required = expected.split(',').map(s => s.trim()).filter(Boolean);
        if (!required.every(c => device.capabilities.includes(c))) {
          return { matches: false, unknownKeys: [] };
        }
        break;
      }
      default:
        unknownKeys.push(key);
        break;
    }
  }
  return { matches: unknownKeys.length === 0, unknownKeys };
}

function toDiscoveredCard(card: any): DiscoveredTriggerCard {
  const id = String(card.id ?? '');
  const shortId = id.startsWith('homey:device:') ? id.split(':').slice(3).join(':') : id;
  return {
    id,
    shortId,
    uri: String(card.uri ?? ''),
    title: titleOf(card.title) ?? shortId,
    args: (card.args ?? []).map((a: any) => ({
      name: a.name,
      type: a.type,
      values: a.values?.map((v: any) => ({ id: String(v.id), title: v.title })),
      filter: a.filter,
      min: a.min,
      max: a.max,
      step: a.step,
    })),
    tokens: (card.tokens ?? []).map((t: any) => ({
      id: String(t.id ?? ''),
      type: String(t.type ?? ''),
      // The title carries the scale, e.g. "Steps (1000/turn)".
      title: t.title,
    })),
  };
}

function titleOf(title: unknown): string | null {
  if (typeof title === 'string') return title;
  if (title && typeof title === 'object' && 'en' in (title as Record<string, unknown>)) {
    return String((title as Record<string, unknown>).en);
  }
  return null;
}

/**
 * Fingerprint the trigger and capability schema used at configuration
 * time: card owner URI, card ID, argument names and types, enum values, token
 * IDs and types. Strictly stronger than hashing the generated flow alone,
 * because it detects an integration changing an argument the flow happens not
 * to set.
 */
/**
 * The version of the normalizer whose OUTPUT a v2 fingerprint describes.
 *
 * Bumped when a change to normalisation would produce a different catalogue from
 * the same cards — a new argument role, a changed collapse rule. Included in the
 * hash so such a change reads as "this surface moved", which is exactly the
 * repair prompt the user needs, rather than passing silently because the cards
 * happen not to have changed.
 */
export const NORMALIZER_VERSION = 1;

/**
 * A wider fingerprint, and deliberately a SECOND one.
 *
 * v1 hashes the card's short id, its argument names, types and enum values, and
 * its token ids and types. What it misses is real: an argument's `filter` (which
 * decides whether the card belongs to this device at all), a numeric argument's
 * bounds, a token's title — which carries the scale, "Steps (1000/turn)", and
 * therefore the difference between a nudge and a slam — and the card's full id
 * and uri.
 *
 * It is not simply widened because the fingerprint is what `HealthMonitor`
 * compares to decide "this remote now exposes different events". Widening it in
 * place would make every installed controller's stored v1 hash disagree with a
 * freshly computed one, and every device would report needs_repair on the
 * upgrade — a mass false alarm about a surface that had not moved.
 *
 * So both are computed. A profile that carries a v2 hash is compared on v2; one
 * that does not keeps v1 semantics until it is next saved or repaired, at which
 * point it gets a v2 and never looks back.
 */
function fingerprintV2Of(device: CatalogDevice, cards: DiscoveredTriggerCard[]): string {
  const shape = {
    normalizer: NORMALIZER_VERSION,
    ownerUri: device.ownerUri,
    driverId: device.driverId,
    cards: [...cards]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(card => ({
        id: card.id,
        uri: card.uri,
        args: [...card.args]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(arg => ({
            name: arg.name,
            type: arg.type,
            filter: arg.filter ?? null,
            min: arg.min ?? null,
            max: arg.max ?? null,
            step: arg.step ?? null,
            values: (arg.values ?? []).map(v => v.id).sort(),
          })),
        tokens: [...card.tokens]
          .sort((a, b) => a.id.localeCompare(b.id))
          // The title is the scale. A token relabelled from "Steps (1000/turn)"
          // to "Steps (500/turn)" is the same shape and a different remote.
          .map(token => `${token.id}:${token.type}:${titleOf(token.title) ?? ''}`),
      })),
  };

  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
}

function fingerprintOf(device: CatalogDevice, cards: DiscoveredTriggerCard[]): string {
  const shape = {
    ownerUri: device.ownerUri,
    driverId: device.driverId,
    cards: [...cards]
      .sort((a, b) => a.shortId.localeCompare(b.shortId))
      .map(card => ({
        id: card.shortId,
        args: [...card.args]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(arg => ({
            name: arg.name,
            type: arg.type,
            values: (arg.values ?? []).map(v => v.id).sort(),
          })),
        tokens: [...card.tokens]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(token => `${token.id}:${token.type}`),
      })),
  };

  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
}
