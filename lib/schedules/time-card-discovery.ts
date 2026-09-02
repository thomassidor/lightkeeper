import { formatMinutes } from './schedule-types';

/**
 * Find Homey's own "the time is …" trigger card, by ENUMERATION.
 *
 * platform §3 is the whole reason this file exists: a card's `uri` is a full
 * resource URI that embeds its own id, so a constructed one yields
 * `404 Not Found`, which reads exactly like a permission refusal and costs hours.
 * Nothing here builds an id or a uri — both are echoed back verbatim from what
 * the Homey reported.
 *
 * The card is matched on SHAPE rather than on a hardcoded id: a manager-owned
 * trigger whose only argument is a time. That keeps working if Athom renames the
 * card or moves it between managers, and it declines the neighbouring cards whose
 * arguments happen to include a time — see KNOWN_TIME_CARDS for what a real Homey
 * actually offers. `candidates` is returned even on success so diagnostics can show
 * what was on offer; when this goes wrong on a firmware we have not seen, that list
 * is the whole investigation.
 */

/**
 * Ids confirmed on real hardware. This RANKS, it never filters: an unknown id of
 * the right shape is still usable, and a known one only wins a tie. Hardcoding it
 * as a requirement would reintroduce exactly the brittleness the shape match
 * exists to avoid.
 *
 * Verified on Homey Pro 2023, firmware 13.4.0: `homey:manager:cron:time_exactly`,
 * one argument, `time` of type `time`.
 */
const KNOWN_TIME_CARDS = ['homey:manager:cron:time_exactly'];

export interface TimeCardRef {
  id: string;
  uri: string;
  /** The argument that carries the time, e.g. 'time'. */
  argument: string;
}

export interface TimeCardCandidate {
  id: string;
  args: string;
  /** Why it was or was not chosen. */
  note: string;
}

export interface TimeCardDiscovery {
  card: TimeCardRef | null;
  candidates: TimeCardCandidate[];
}

/** What the flow argument expects: Homey time arguments are 'HH:mm' strings. */
export function timeArgumentValue(minutes: number): string {
  return formatMinutes(minutes);
}

export function discoverTimeCard(triggers: unknown[]): TimeCardDiscovery {
  const candidates: TimeCardCandidate[] = [];
  const scored: Array<{ score: number; card: TimeCardRef }> = [];

  for (const raw of triggers as any[]) {
    const id = String(raw?.id ?? '');
    // Only Homey's own managers. An app-provided time card would work, but it
    // exists only while that app runs (platform §3), which is not a dependency to take on
    // for something this load-bearing.
    if (!id.startsWith('homey:manager:')) continue;

    const args = (raw?.args ?? []) as any[];
    const summary = args.map(a => `${String(a?.name ?? '?')}:${String(a?.type ?? '?')}`).join(', ') || 'none';
    const timeArg = args.find(a => String(a?.type ?? '') === 'time')
      ?? args.find(a => String(a?.name ?? '') === 'time');

    if (!timeArg) continue;
    if (args.length !== 1) {
      candidates.push({ id, args: summary, note: 'has a time argument, but not only that' });
      continue;
    }

    // Preference, not a requirement: the shape is the test, everything else ranks.
    const known = KNOWN_TIME_CARDS.includes(id) ? 4 : 0;
    const named = /cron|time|clock|date/.test(id) ? 1 : 0;
    const typed = String(timeArg?.type ?? '') === 'time' ? 2 : 0;
    const score = known + named + typed;

    candidates.push({ id, args: summary, note: `usable (score ${score})` });
    scored.push({
      score,
      card: { id, uri: String(raw?.uri ?? ''), argument: String(timeArg?.name ?? 'time') },
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  // A card with no uri is unusable: we may not invent one.
  if (!best || !best.card.uri) return { card: null, candidates };

  /**
   * Two cards of the same shape and the same score: refuse rather than pick.
   *
   * `sort` is stable, so a tie resolves to whichever the Homey happened to list
   * first — a firmware-dependent coin toss deciding what every schedule on the
   * Homey triggers on. Refusing surfaces `state.noTimeCard`, which already asks
   * the user to report their firmware version, and `candidates` names both. That
   * is a schedule that says it cannot be built; the alternative is one that fires
   * from an unknown card and looks fine.
   */
  const tied = scored.filter(s => s.score === best.score);
  if (tied.length > 1) {
    for (const candidate of candidates) {
      if (tied.some(t => t.card.id === candidate.id)) {
        candidate.note += ` — tied with ${tied.length - 1} other card(s), so none was chosen`;
      }
    }
    return { card: null, candidates };
  }

  return { card: best.card, candidates };
}
