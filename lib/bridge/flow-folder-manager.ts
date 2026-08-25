import type { HomeyApiService } from '../homey-api-service';
import { redactKeyMaterial } from '../credential-service';

/**
 * Everything this app knows about Homey's Flow FOLDERS.
 *
 * Split out of FlowBridgeManager so that one stays about flows: folders are
 * presentation only, and nothing about ownership or attribution may ever start
 * depending on them (a flow is ours because our bridge action carries the
 * controller id — see findManagedFlows).
 *
 * The layout we maintain is one folder per Lightkeeper device, nested inside a
 * single app-level folder:
 *
 *   Lightkeeper/
 *     Kitchen dial/      <- named after the Lightkeeper DEVICE, not the remote
 *     Evening lights/
 *
 * Nesting is real: a FlowFolder carries `parent`, and both createFlowFolder and
 * updateFlowFolder accept it. See CLAUDE.md §11.
 *
 * TWO RULES HOLD UP EVERY METHOD HERE:
 *
 * 1. Folder work NEVER blocks a flow write. Every method catches its own
 *    failures and degrades to "no folder" or "no change". A user with a folder
 *    problem still gets working flows.
 * 2. We only ever move a flow OUT OF OUR OWN root folder. A flow the user
 *    dragged somewhere else stays there — that is a promise in the README, and
 *    hasBeenUserEdited() deliberately never compares folders, so the flow is
 *    reused in place rather than dragged back.
 */

export const MANAGED_FOLDER_NAME = 'Lightkeeper';

interface FolderRecord {
  id: string;
  name: string;
  parent: string | null;
}

/**
 * Every folder on the Homey plus which of them is ours, read ONCE per
 * reconcile.
 *
 * This replaced a `folderId` cached for the app's whole lifetime and never
 * revalidated: deleting the Lightkeeper folder on the Homey left every later
 * createFlow pointing at an id that no longer existed. sync() already reads
 * every flow, so one more read costs nothing and cannot go stale.
 */
export interface FolderView {
  /** The app-level folder. Undefined when it could not be read or created. */
  root: string | undefined;
  folders: Map<string, FolderRecord>;
}

/** A view that resolves to no folder at all — the non-fatal degraded state. */
export const NO_FOLDERS: FolderView = { root: undefined, folders: new Map() };

/** Enough of a live flow for folder decisions. */
export interface FlowFolderInfo {
  id: string;
  folder: string | null | undefined;
  /** The controller id from our bridge action, or '' when the flow is not ours. */
  controllerId: string;
}

export class FlowFolderManager {
  constructor(
    private readonly api: HomeyApiService,
    private readonly log: (...args: unknown[]) => void,
  ) { }

  /**
   * Read every folder and resolve (creating if needed) the app-level one.
   *
   * The root is matched on name AND parent. Without the parent check a device
   * folder a user happened to name "Lightkeeper" would be picked as the root,
   * and every device's flows would nest inside one device's folder.
   */
  async load(): Promise<FolderView> {
    try {
      const client = await this.api.read();
      const records = (Object.values(await client.flow.getFlowFolders()) as any[])
        .map(toRecord);
      const folders = new Map(records.map(f => [f.id, f]));

      const existing = records.find(f => f.name === MANAGED_FOLDER_NAME && f.parent === null);
      if (existing) return { root: existing.id, folders };

      const created = await this.api.withWriteClient(async write =>
        write.flow.createFlowFolder({ flowfolder: { name: MANAGED_FOLDER_NAME } }));
      const record = toRecord(created);
      folders.set(record.id, record);
      return { root: record.id, folders };
    } catch (error) {
      this.warn('Could not read or create the Lightkeeper folder', error);
      return NO_FOLDERS;
    }
  }

  /**
   * The folder this device's flows belong in, created if it does not exist yet.
   *
   * Resolution prefers the folder the device's OWN flows already sit in, when
   * that folder is one of ours. That is what makes renaming work without
   * persisting a folder id anywhere: after a rename the device's flows are
   * still in the folder we made, it just carries the old name, and
   * renameIfOurs() fixes the name rather than moving every flow.
   */
  async resolveForDevice(
    view: FolderView,
    flows: FlowFolderInfo[],
    controllerId: string,
    deviceName: string,
  ): Promise<string | undefined> {
    if (!view.root) return undefined;

    const ourFolder = flows
      .filter(f => f.controllerId === controllerId)
      .map(f => (f.folder ? view.folders.get(f.folder) : undefined))
      .find(folder => folder !== undefined && folder.parent === view.root);
    if (ourFolder) return ourFolder.id;

    const name = folderNameFor(deviceName);
    // No name to file it under yet — the app folder itself, exactly as before
    // per-device folders existed. A folder called "Lightkeeper/Lightkeeper" is
    // worse than no subfolder.
    if (!name) return view.root;

    const byName = [...view.folders.values()]
      .find(f => f.parent === view.root && f.name === name);
    if (byName) return byName.id;

    try {
      const created = await this.api.withWriteClient(async write =>
        write.flow.createFlowFolder({ flowfolder: { name, parent: view.root } }));
      const record = toRecord(created);
      view.folders.set(record.id, record);
      return record.id;
    } catch (error) {
      this.warn(`Could not create the folder for "${name}"`, error);
      return undefined;
    }
  }

  /**
   * Follow a device rename.
   *
   * Guarded: only when every flow in the folder belongs to THIS device. Two
   * Lightkeeper devices the user gave the same name share one folder, and
   * without the guard each would rename it back on every reconcile — the folder
   * would flip names for as long as both devices existed. A folder holding a
   * flow of the user's own is left alone for the same reason.
   */
  async renameIfOurs(
    view: FolderView,
    flows: FlowFolderInfo[],
    folderId: string,
    controllerId: string,
    deviceName: string,
  ): Promise<void> {
    const folder = view.folders.get(folderId);
    const name = folderNameFor(deviceName);
    if (!name || !folder || folder.parent !== view.root || folder.name === name) return;

    const occupants = flows.filter(f => f.folder === folderId);
    if (occupants.some(f => f.controllerId !== controllerId)) return;

    try {
      await this.api.withWriteClient(async write =>
        write.flow.updateFlowFolder({ id: folderId, flowfolder: { name } }));
      view.folders.set(folderId, { ...folder, name });
      this.log(`Renamed the Flow folder "${folder.name}" to "${name}"`);
    } catch (error) {
      this.warn(`Could not rename the folder "${folder.name}"`, error);
    }
  }

  /**
   * Move already-created flows into the device's folder.
   *
   * createFlow is the only place a flow's folder is ever set, and a reused flow
   * is never rewritten — so without this an install that predates per-device
   * folders would keep every flow in the flat root forever.
   *
   * A flow is moved ONLY from the root, or from no folder at all. Anywhere else
   * means the user put it there.
   */
  async placeExisting(
    view: FolderView,
    flows: FlowFolderInfo[],
    flowIds: Set<string>,
    folderId: string,
  ): Promise<number> {
    if (!view.root) return 0;

    let moved = 0;
    for (const flow of flows) {
      if (!flowIds.has(flow.id)) continue;
      if (flow.folder === folderId) continue;
      if (flow.folder && flow.folder !== view.root) continue;

      try {
        await this.api.withWriteClient(async write =>
          write.flow.updateFlow({ id: flow.id, flow: { folder: folderId } }));
        flow.folder = folderId;
        moved += 1;
      } catch (error) {
        // Organisational only: a flow that would not move still works.
        this.warn(`Could not move flow ${flow.id} into its device folder`, error);
      }
    }
    if (moved > 0) this.log(`Moved ${moved} flow(s) into their device folder`);
    return moved;
  }

  /**
   * Delete device folders left empty by a deletion.
   *
   * Re-reads the flows rather than trusting the caller's copy — the deletes it
   * just made are exactly what changed. The root is never a candidate: an empty
   * "Lightkeeper" folder is the anchor the next device resolves against, not
   * litter.
   */
  async cleanUpEmpty(view: FolderView, candidates: Iterable<string>): Promise<number> {
    const wanted = [...candidates].filter(id => {
      const folder = view.folders.get(id);
      return folder !== undefined && folder.parent === view.root;
    });
    if (wanted.length === 0) return 0;

    let deleted = 0;
    try {
      const client = await this.api.read();
      const occupied = new Set(
        (Object.values(await client.flow.getFlows()) as any[]).map(f => String(f?.folder ?? '')),
      );

      for (const id of wanted) {
        if (occupied.has(id)) continue;
        try {
          await this.api.withWriteClient(async write => write.flow.deleteFlowFolder({ id }));
          view.folders.delete(id);
          deleted += 1;
        } catch (error) {
          this.warn(`Could not delete the empty folder ${id}`, error);
        }
      }
    } catch (error) {
      this.warn('Could not check which folders are now empty', error);
    }

    if (deleted > 0) this.log(`Removed ${deleted} empty device folder(s)`);
    return deleted;
  }

  /** Redacted as well as sanitised upstream: these lines go to the app log. */
  private warn(what: string, error: unknown): void {
    this.log(`${what}:`, redactKeyMaterial(String((error as Error)?.message ?? '')));
  }
}

/**
 * The folder name for a device, or undefined when it has nothing usable to be
 * named after. createFlowFolder requires a name, and a blank one is not worth
 * a folder.
 */
export function folderNameFor(deviceName: string): string | undefined {
  return deviceName.trim() || undefined;
}

function toRecord(raw: any): FolderRecord {
  return {
    id: String(raw?.id ?? ''),
    name: String(raw?.name ?? ''),
    parent: raw?.parent ? String(raw.parent) : null,
  };
}
