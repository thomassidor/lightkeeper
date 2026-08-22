import { formatMinutes } from './schedule-types';

/**
 * Find Homey's own "the time is …" trigger card, by ENUMERATION.
 *
 * §3 of CLAUDE.md is the whole reason this file exists: a card's `uri` is a full
 * resource URI that embeds its own id, so a constructed one yields
 * `404 Not Found`, which reads exactly like a permission refusal and costs hours.
 * Nothing here builds an id or a uri — both are echoed back verbatim from what
 * the Homey reported.
 *
 * The card is matched on SHAPE rather than on a hardcoded id: a manager-owned
 * trigger whose only argument is a time. That keeps working if Athom renames the
 * card or moves it between managers, and it declines the neighbouring
 * "every N minutes" cards, whose argument is a number. `candidates` is returned
 * even on success so diagnostics can show what was on offer — when this goes
 * wrong on a firmware we have not seen, the list is the whole investigation.
 */

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
    // exists only while that app runs (§3), which is not a dependency to take on
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

    // Preference, not a requirement: the naming is a hint, the shape is the test.
    const named = /cron|time|clock|date/.test(id) ? 1 : 0;
    const typed = String(timeArg?.type ?? '') === 'time' ? 2 : 0;
    const score = named + typed;

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

  return { card: best.card, candidates };
}
