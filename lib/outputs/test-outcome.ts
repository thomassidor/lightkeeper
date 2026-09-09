import type { WriteOutcome } from './command-scheduler';

/** Count lamps only after every command in this request has settled. */
export function acceptedTargets(outcomes: WriteOutcome[]): number {
  const devices = new Map<string, boolean>();
  for (const outcome of outcomes) {
    devices.set(outcome.deviceId, (devices.get(outcome.deviceId) ?? true)
      && outcome.status === 'succeeded');
  }
  const accepted = [...devices.values()].filter(Boolean).length;
  const failed = devices.size - accepted;
  if (failed > 0) {
    throw new Error(`Homey accepted all commands for ${accepted} of ${devices.size} lights; ${failed} failed or were cancelled. Check the write log for details.`);
  }
  return accepted;
}
