import { messageOf } from '../support/homey-errors';
/**
 * Fire-and-forget with a rejection handler.
 *
 * Several call sites deliberately do not await: a catalogue change must not
 * block the watcher that delivered it, a ramp tick must not block the timer,
 * and app start must not wait on a slow Homey. What they must not do is drop
 * the rejection — an unhandled promise rejection inside an app is invisible
 * from outside and, on some Node builds, fatal.
 *
 * This is the whole mechanism: log and continue. No retry, no queue, no
 * swallowing into a state machine. Anything that needs those has a manager.
 */
export function fireAndForget(
  promise: Promise<unknown>,
  log: (...args: unknown[]) => void,
  label: string,
): void {
  promise.catch((error: unknown) => {
    log(`${label} failed:`, messageOf(error));
  });
}
