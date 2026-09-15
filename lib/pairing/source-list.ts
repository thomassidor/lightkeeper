/**
 * The "choose a remote" screen's data.
 *
 * Two lists, both grouped by room: the devices Homey can hear a gesture from,
 * and everything else folded away behind one row. The screen used to draw a
 * single alphabetical list of EVERY device on the Homey — a hundred and more on
 * an ordinary house — on the grounds that there is no reliable way to tell a
 * remote from anything else that exposes trigger cards, and that a wrong guess
 * at the top of a list is worse than an honest one.
 *
 * That reasoning answered the wrong question. The screen does not have to
 * recognise a remote; it has to hide what CANNOT work, and `eventCount` says
 * exactly that — a device with none is the device `selectSource` will refuse a
 * moment later with "nothing can be read from it". So the split is a statement
 * about what Homey can hear, not a guess about what a device is, and nothing is
 * removed: the second list holds every one of them, in its room, and a search
 * box spans both.
 *
 * The COUNTING is `SourceDiscoveryService.rankSources`, which is where the
 * judgement lives. This is the split, the grouping and the two sorts — which is
 * exactly the kind of thing that looks too simple to test right up until a room
 * called "Ã…rhus" sorts to the wrong end of the list.
 */

export interface RankedSource {
  device: {
    id: string;
    name: string;
    zone?: string | null;
    zoneName?: string | null;
    ownerName?: string | null;
    available?: boolean;
  };
  eventCount: number;
}

export interface SourceRoom {
  zoneName: string;
  /**
   * `sources`, not `devices`: the two sibling pickers name this list after what
   * it holds — `lights` in target-picker.ts, `sensors` in sensor-picker.ts —
   * and the screen that draws this one reads `room.sources`. It said `devices`
   * once, which the view could only report as
   * "Cannot read properties of undefined (reading 'length')".
   */
  sources: Array<{
    id: string;
    name: string;
    zoneName: string | null | undefined;
    ownerName: string | null | undefined;
    available: boolean | undefined;
    eventCount: number;
    selected: boolean;
  }>;
}

export interface SourceList {
  /** Rooms holding the devices Homey can hear a gesture from. Drawn open. */
  rooms: SourceRoom[];
  /** Rooms holding everything else, behind one row the user can open. */
  others: SourceRoom[];
  /** How many devices are in `rooms`, so the screen can say what it folded. */
  candidateCount: number;
  /** How many are in `others`, for the row that unfolds them. */
  otherCount: number;
}

/**
 * Split the house into "could drive the lights" and "everything else".
 *
 * @param selectedId the source already chosen, so repair opens on it
 * @param unassignedLabel resolved by the driver; `lib/` cannot translate
 */
export function buildSourceList(
  ranked: RankedSource[],
  selectedId: string | undefined,
  unassignedLabel = 'Unassigned',
): SourceList {
  const candidates: RankedSource[] = [];
  const others: RankedSource[] = [];

  for (const source of ranked) {
    /**
     * The chosen one is always a candidate, whatever it now reports.
     *
     * A repair session opens on the remote the controller was built from, and
     * the reason to repair is often that the integration changed underneath it
     * and the device stopped exposing anything. Folding it away would show a
     * screen whose only tick is somewhere the user cannot see, and the one
     * device this session is about would be the one thing hidden.
     */
    if (source.eventCount > 0 || source.device.id === selectedId) candidates.push(source);
    else others.push(source);
  }

  return {
    rooms: groupSourcesByRoom(candidates, selectedId, unassignedLabel),
    others: groupSourcesByRoom(others, selectedId, unassignedLabel),
    candidateCount: candidates.length,
    otherCount: others.length,
  };
}

/**
 * @param selectedId the source already chosen, so repair opens on it
 * @param unassignedLabel resolved by the driver; `lib/` cannot translate
 */
export function groupSourcesByRoom(
  ranked: RankedSource[],
  selectedId: string | undefined,
  unassignedLabel = 'Unassigned',
): SourceRoom[] {
  const byZone = new Map<string, SourceRoom>();

  for (const { device, eventCount } of ranked) {
    // A device with no zone still has to appear: "not in a room" is a state
    // Homey allows, and a remote that is simply missing from this screen is
    // indistinguishable from one the app cannot drive.
    const key = device.zone ?? 'unknown';
    if (!byZone.has(key)) {
      byZone.set(key, { zoneName: device.zoneName || unassignedLabel, sources: [] });
    }
    byZone.get(key)!.sources.push({
      id: device.id,
      name: device.name,
      zoneName: device.zoneName,
      ownerName: device.ownerName,
      available: device.available,
      eventCount,
      selected: device.id === selectedId,
    });
  }

  // `localeCompare` at both levels, not `<`: the rooms in a Danish house sort
  // Æ Ø Å after Z, and a code-point sort puts them somewhere else entirely.
  return [...byZone.values()]
    .sort((a, b) => a.zoneName.localeCompare(b.zoneName))
    .map(room => ({
      zoneName: room.zoneName,
      sources: [...room.sources].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}
