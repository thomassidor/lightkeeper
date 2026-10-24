import Homey from 'homey';

import type { LightkeeperApp } from '../app-contract';
import { lightsSummary } from '../pairing/flow-screens';
import { timezoneOf, type PairSessionHost } from '../pairing/pair-session';
import type { TargetSpec } from '../outputs/light-intent';
import { translatorFor } from '../support/i18n';

/**
 * The `Homey.Driver` half every Lightkeeper driver shares: the seams a pairing
 * session reaches the app through, and nothing about any one device type.
 *
 * `LightkeeperDevice`'s sibling, for the same reason it exists. All five drivers
 * carried these members byte for byte — the translator, the pair-session host,
 * the typed app, the timezone and the lights row — and the `app` getter below
 * records what one of those copies cost before it was typed. Every pairing
 * DECISION still lives in `lib/pairing/`, where a test can import it; this is
 * only the shell that hands those decisions a host (platform §13).
 */
export abstract class LightkeeperDriver extends Homey.Driver {
  /** Which driver this is, for the one line `onInit` logs. */
  protected abstract readonly label: string;

  /**
   * `homey.__`, plural-aware: a key that is a plural group picks its form from
   * the numeric `count` token (lib/support/i18n.ts). Every string a driver
   * resolves goes through here, so a counted one cannot be missed.
   *
   * A property rather than a method so it can be handed, as is, to the lib/
   * helpers that take a translator.
   */
  protected readonly tr = (key: string, tokens?: Record<string, string | number>): string =>
    translatorFor(this.homey)(key, tokens);

  /**
   * The app, through the contract rather than as `any`.
   *
   * This used to be `: any`, and the hardware pass is what found out what that
   * cost: `catalog.devices()` and `catalog.getDevice()` do not exist — the
   * methods are `allDevices()` and `device()` — and six call sites across three
   * drivers shipped, invisible to `tsc`, the suite and `validate` alike,
   * throwing the first time a real screen asked for them. `this.homey.app` is
   * `App` from the SDK's own types, so the double cast is the seam; `LightkeeperApp`
   * is the surface a driver is allowed to use.
   */
  protected get app(): LightkeeperApp {
    return this.homey.app as unknown as LightkeeperApp;
  }

  /**
   * What `lib/pairing/pair-session.ts` needs of a driver.
   *
   * Five members and no `Homey.Driver` among them, which is the point: the
   * shared mechanics stay importable by a test (platform §13). Built per call
   * because a session binds it once and it costs nothing.
   */
  protected pairHost(): PairSessionHost {
    return {
      log: (...args: unknown[]) => this.log(...args),
      error: (...args: unknown[]) => this.error(...args),
      translate: this.tr,
      clock: this.homey.clock,
      app: this.app,
    };
  }

  protected timezone(): string | null {
    return timezoneOf(this.pairHost());
  }

  /**
   * What the lights row reads back — and WHICH of the two shapes it stored.
   *
   * "Everything in Kitchen" and "4 picked" behave differently the next time
   * somebody adds a lamp to that room, and this line is the only place that
   * difference is ever visible. `lights.html` deliberately does not show it:
   * making the picker explain its own storage would be a control nobody asked
   * for, on the screen least able to afford one.
   */
  protected async lightsSummary(target: TargetSpec, summary: { count: number }): Promise<string> {
    return lightsSummary(this.pairHost(), target, summary, () => this.app.catalog.allZones());
  }

  override async onInit(): Promise<void> {
    this.log(`${this.label} driver initialised`);
  }
}
