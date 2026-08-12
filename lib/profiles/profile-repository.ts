import { migrateProfile } from './migrations';
import type { ControllerProfile } from './controller-profile';

/**
 * Spec §9.1 — profiles live in the virtual device store; app-level settings are
 * only for global configuration and migrations.
 *
 * This wraps the device store so migration is unavoidable: every read goes
 * through it, so no caller can accidentally consume an unmigrated profile.
 */

export interface ProfileStore {
  getStoreValue(key: string): unknown;
  setStoreValue(key: string, value: unknown): Promise<void>;
}

const KEY = 'profile';

export class ProfileRepository {
  constructor(
    private readonly store: ProfileStore,
    private readonly log: (...args: unknown[]) => void,
  ) {}

  /** Returns null when there is nothing stored, or it cannot be migrated. */
  load(): ControllerProfile | null {
    const raw = this.store.getStoreValue(KEY);
    if (!raw) return null;

    try {
      const { profile, migrated, fromVersion, steps } = migrateProfile(raw);
      if (migrated) {
        this.log(`Migrated profile from schema ${fromVersion} via ${steps.join(' → ')}`);
        void this.store.setStoreValue(KEY, profile);
      }
      return profile;
    } catch (error) {
      // Refusing beats silently replacing a user's configuration with defaults.
      this.log('Could not migrate profile:', (error as Error)?.message);
      return null;
    }
  }

  async save(profile: ControllerProfile): Promise<void> {
    await this.store.setStoreValue(KEY, profile);
  }

  /**
   * Persist only the managed-flow references, leaving everything else as it is.
   * Reconciliation runs often and must not race a concurrent profile edit.
   */
  async saveManagedFlows(profile: ControllerProfile, managedFlows: ControllerProfile['managedFlows']): Promise<ControllerProfile> {
    const updated = { ...profile, managedFlows };
    await this.save(updated);
    return updated;
  }
}
