import { createHash } from 'node:crypto';

import type { HomeyApiService } from './homey-api-service';
import type { CatalogDevice } from './device-catalog';
import {
  normalizeCards,
  type DiscoveredTriggerCard,
} from './inputs/event-normalizer';
import type { SelectableInput } from './inputs/selectable-input';

/**
 * Spec §5.1 — discovery order, corrected against what the platform actually
 * exposes (see CLAUDE.md).
 *
 * Device-scoped trigger cards encode their device in the card ID:
 *     homey:device:<deviceId>:<cardName>
 * NO card carries a uri of `homey:device:<deviceId>`, so matching on uri — the
 * obvious reading of §5.1.3 — finds nothing and makes every remote look
 * eventless.
 *
 * Capability inspection (§5.1.2) is interface-only: no device tested so far
 * exposes input as a capability change (§2.1). The seam exists so adding one
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
  /** Cards declined, with why — surfaced in diagnostics only (§9.5). */
  rejected: Array<{ cardId: string; reason: string }>;
  /** §9.3 — what makes repair safe after an integration update. */
  fingerprint: string;
  matchRoutes: MatchRoute[];
  cardsInspected: number;
}

export class SourceDiscoveryService {
  constructor(private readonly api: HomeyApiService) {}

  async discover(device: CatalogDevice): Promise<DiscoveryResult> {
    const client = await this.api.read();
    const allCards = Object.values(await client.flow.getFlowCardTriggers()) as any[];

    const matched: Array<{ card: DiscoveredTriggerCard; routes: MatchRoute[] }> = [];

    for (const card of allCards) {
      const routes = matchRoutesFor(card, device);
      if (routes.length === 0) continue;
      matched.push({ card: toDiscoveredCard(card), routes });
    }

    // Strong matches only reach the picker. An unfiltered device argument
    // accepts every device on the Homey — it once offered "refrigerator error
    // changed" as an input for a dial. Kept reachable via diagnostics, never
    // ranked into the catalogue.
    const strong = matched.filter(m =>
      m.routes.includes('device_scoped') || m.routes.includes('device_arg'));

    const { inputs, rejected } = normalizeCards(strong.map(m => m.card), {
      sourceDeviceId: device.id,
    });

    return {
      device,
      inputs,
      rejected,
      fingerprint: fingerprintOf(device, strong.map(m => m.card)),
      matchRoutes: [...new Set(strong.flatMap(m => m.routes))],
      cardsInspected: allCards.length,
    };
  }

  /**
   * §8.1 — rank plausible sources first, never hard-filter. A device with no
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
 * Phase 0: device cards are identified by ID (`homey:device:<id>:<card>`), never
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
export function matchRoutesFor(card: any, device: CatalogDevice): MatchRoute[] {
  const routes: MatchRoute[] = [];

  if (deviceIdOfScopedCard(String(card.id ?? '')) === device.id) {
    routes.push('device_scoped');
  }

  for (const arg of (card.args ?? []) as any[]) {
    if (arg?.type !== 'device') continue;
    if (!deviceMatchesFilter(arg.filter, device)) continue;
    routes.push(arg.filter ? 'device_arg' : 'device_arg_unfiltered');
  }

  // Deliberately NOT matching on "same owning app": it offered Hue
  // motion-area triggers as buttons on a Hue dial.
  return routes;
}

/**
 * Whether a device satisfies a card argument's `filter` query string.
 *
 * An absent or empty filter accepts everything — that is the SDK's own
 * semantics, and it is why 'device_arg_unfiltered' is tracked as a weaker
 * route than a filtered match.
 */
export function deviceMatchesFilter(filter: unknown, device: CatalogDevice): boolean {
  if (filter === undefined || filter === null || filter === '') return true;
  if (typeof filter !== 'string') return false;

  const params = new URLSearchParams(filter);
  for (const [key, expected] of params.entries()) {
    switch (key) {
      case 'driver_id': {
        const driverId = String(device.driverId ?? '');
        if (driverId !== expected && (driverId.split(':').pop() ?? '') !== expected) return false;
        break;
      }
      case 'driver_uri':
        if (!String(device.driverId ?? '').startsWith(expected)) return false;
        break;
      case 'class': {
        const classes = expected.split('|');
        if (!classes.includes(device.class) && !classes.includes(device.virtualClass ?? '')) return false;
        break;
      }
      case 'capabilities': {
        const required = expected.split(',').map(s => s.trim()).filter(Boolean);
        if (!required.every(c => device.capabilities.includes(c))) return false;
        break;
      }
      default:
        // Unknown keys are ignored rather than treated as a mismatch: failing
        // closed here would silently hide usable cards.
        break;
    }
  }
  return true;
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
 * §9.3 — fingerprint the trigger and capability schema used at configuration
 * time: card owner URI, card ID, argument names and types, enum values, token
 * IDs and types. Strictly stronger than hashing the generated flow alone,
 * because it detects an integration changing an argument the flow happens not
 * to set.
 */
export function fingerprintOf(device: CatalogDevice, cards: DiscoveredTriggerCard[]): string {
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
