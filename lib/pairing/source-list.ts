/**
 * The "choose a remote" screen's data.
 *
 * Grouped by room with a search box, rather than a "likely remotes" section at
 * the top: there is no reliable way to tell a remote from anything else that
 * happens to expose trigger cards, and a wrong guess at the top of a list is
 * worse than an honest alphabetical one.
 *
 * The RANKING is `SourceDiscoveryService.rankSources`, which is where the
 * judgement lives. This is only the grouping and the two sorts — which is
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
  devices: Array<{
    id: string;
    name: string;
    zoneName: string | null | undefined;
    ownerName: string | null | undefined;
    available: boolean | undefined;
    eventCount: number;
    selected: boolean;
  }>;
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
      byZone.set(key, { zoneName: device.zoneName || unassignedLabel, devices: [] });
    }
    byZone.get(key)!.devices.push({
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
      devices: [...room.devices].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}
