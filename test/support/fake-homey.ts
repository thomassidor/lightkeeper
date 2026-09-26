import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FakeTimers } from './fake-timers';
import { localise } from '../../lib/support/i18n';

/**
 * A fake Homey SDK, installed the moment this file is imported.
 *
 * **Why it exists.** `require('homey')` only resolves on a Homey (platform §13).
 * Anywhere else it resolves to the CLI in `node_modules`, whose main executes the
 * CLI, so every file containing `extends Homey.App`, `Homey.Driver` or
 * `Homey.Device` died on import with `Class extends value undefined` — and
 * `app.ts`, all five `driver.ts`, all five `device.ts` and
 * `lib/devices/lightkeeper-device.ts` were executed by no test at all. The rules
 * were lifted out into `lib/` one by one to work round that, and what could not
 * be lifted — the wiring between them — was asserted by reading source text with
 * a regex, which proves a line exists and nothing about what it does.
 *
 * **How.** `Module._resolveFilename` is wrapped so the bare request `'homey'`
 * resolves to THIS file, whose default export is the three base classes below.
 * The suite's `.ts` files are compiled to CommonJS by tsx, so an entry point's
 * `import Homey from 'homey'` is a `require('homey')` that goes through the hook
 * — and since this file is already in the require cache by then, the classes a
 * driver extends are the very classes a test can `instanceof` against.
 *
 * **Usage.** Import it FIRST, before anything that loads an entry point:
 *
 *     import { fakeHomey, FakePairSession } from '../support/fake-homey';
 *     const ControllerDriver = require('../../drivers/controller/driver');
 *
 * `require`, not `import`, for the entry points themselves: they are
 * `module.exports = class …` (a Homey entry point with `export default` is not
 * loaded at all, platform §13), which TypeScript sees as a module with no
 * default export. No new flags for `npm test` or a single-file run — the hook is
 * installed by the import, not by the runner.
 *
 * **What it is NOT.** It is the SDK surface this app uses, recorded rather than
 * simulated: nothing here knows what Homey would DO with a capability write or a
 * Flow card. The one behaviour it reproduces on purpose is `__`, which resolves
 * from `locales/en.json` exactly as the device does, so a test can assert on the
 * sentence a user would read — and a key that does not exist comes back as the
 * key, which is visible.
 */

const ROOT = join(import.meta.dirname, '..', '..');

// ------------------------------------------------------------ the hook

type Resolve = (request: string, ...rest: unknown[]) => string;
const moduleWithResolver = Module as unknown as { _resolveFilename: Resolve };
const HOOKED = Symbol.for('lightkeeper.fake-homey.hooked');

if (!(moduleWithResolver._resolveFilename as unknown as Record<symbol, boolean>)[HOOKED]) {
  const original = moduleWithResolver._resolveFilename;
  const self = import.meta.filename;
  const hooked: Resolve = function (this: unknown, request, ...rest) {
    if (request === 'homey') return self;
    return original.call(this, request, ...rest);
  };
  (hooked as unknown as Record<symbol, boolean>)[HOOKED] = true;
  moduleWithResolver._resolveFilename = hooked;
}

// ------------------------------------------------------------ helpers

function line(args: unknown[]): string {
  return args.map(arg => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' ');
}

const EN = JSON.parse(readFileSync(join(ROOT, 'locales', 'en.json'), 'utf8')) as Record<string, unknown>;

/**
 * `homey.__`, resolving from `locales/en.json`.
 *
 * `__token__` placeholders are substituted the way the SDK does. A key that is
 * not there comes back as itself, so a test that asserts on a sentence fails
 * loudly on a typo rather than on an empty string.
 */
export function translate(key: string, tokens: Record<string, unknown> = {}): string {
  let node: unknown = EN;
  for (const part of key.split('.')) {
    node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
  }
  if (typeof node !== 'string') return key;
  return node.replace(/__(\w+)__/g, (whole, name: string) =>
    (Object.prototype.hasOwnProperty.call(tokens, name) ? String(tokens[name]) : whole));
}

/**
 * `translate`, made plural-aware exactly as the drivers make `homey.__` —
 * lib/support/i18n.ts. What a `lib/` helper that takes a translator is handed.
 */
export function localised(key: string, tokens: Record<string, string | number> = {}): string {
  return localise(translate, key, tokens);
}

// ------------------------------------------------------------ the SDK

/**
 * What every SDK class carries: `homey`, and a `log`/`error` that RECORD.
 *
 * Recorded because half of what these shells do that is worth asserting is a
 * line in the log — "Ignoring set_lights: …", "Source changed: removed 3 of 3".
 */
class Recorder {
  homey!: FakeHomey;
  readonly logs: string[] = [];
  readonly errors: string[] = [];

  log(...args: unknown[]): void { this.logs.push(line(args)); }
  error(...args: unknown[]): void { this.errors.push(line(args)); }
}

/** `Homey.App`. The app class assigns `homey` before `onInit`, as the SDK does. */
export class App extends Recorder {
  async onInit(): Promise<void> { /* overridden */ }
  async onUninit(): Promise<void> { /* overridden */ }
}

/** `Homey.Driver`. `getDevices()` answers from `devices`, which a test fills. */
export class Driver extends Recorder {
  devices: unknown[] = [];
  getDevices(): unknown[] { return [...this.devices]; }
  async onInit(): Promise<void> { /* overridden */ }
}

/** A device's own recorded state. Filled by `makeDevice`, read by assertions. */
export interface FakeDeviceState {
  data: { id: string };
  name: string;
  store: Map<string, unknown>;
  /** Capability id -> current value. Presence is `hasCapability`. */
  capabilities: Map<string, unknown>;
  available: boolean;
  unavailableMessage: string | null;
  /** Every availability change, in order: `true`, or the unavailable text. */
  availability: Array<true | string>;
  /** Every `setCapabilityValue`, in order. */
  writes: Array<{ capability: string; value: unknown }>;
  /** Every `setStoreValue`, in order. */
  storeWrites: Array<{ key: string; value: unknown }>;
  listeners: Map<string, (value: unknown, opts?: unknown) => unknown>;
  /** Capability id -> its options, as `setCapabilityOptions` last set them. */
  capabilityOptions: Map<string, Record<string, unknown>>;
  /** Make the next store write of this key reject, the way a full disk does. */
  failStoreWrites: Set<string>;
  /** The device page's warning banner, and every change to it: text, or null. */
  warning: string | null;
  warnings: Array<string | null>;
}

/**
 * `Homey.Device`, as the fifteen members the device layer uses.
 *
 * `setCapabilityValue` on a capability the device does not have REJECTS, like
 * the SDK — `DeviceLifecycle` relies on that (its first-init `onoff` write has a
 * `.catch` for exactly this), so a fake that accepted anything would prove less.
 */
export class Device extends Recorder {
  fake!: FakeDeviceState;

  getData(): { id: string } { return this.fake.data; }
  getName(): string { return this.fake.name; }
  /** `any`, as the SDK's own is: a store holds whatever the device type put in it. */
  getStoreValue(key: string): any { return this.fake.store.get(key); }
  getStore(): Record<string, unknown> { return Object.fromEntries(this.fake.store); }

  async setStoreValue(key: string, value: unknown): Promise<void> {
    if (this.fake.failStoreWrites.has(key)) {
      this.fake.failStoreWrites.delete(key);
      throw new Error(`store write of "${key}" failed`);
    }
    // A structured clone, as the SDK persists: a test that mutates the object it
    // stored must not be reading its own mutation back as the store.
    const copy = value === undefined ? undefined : structuredClone(value);
    this.fake.store.set(key, copy);
    this.fake.storeWrites.push({ key, value: copy });
  }

  hasCapability(id: string): boolean { return this.fake.capabilities.has(id); }
  getCapabilities(): string[] { return [...this.fake.capabilities.keys()]; }
  getCapabilityValue(id: string): unknown { return this.fake.capabilities.get(id) ?? null; }
  async addCapability(id: string): Promise<void> {
    if (!this.fake.capabilities.has(id)) this.fake.capabilities.set(id, null);
  }
  async removeCapability(id: string): Promise<void> { this.fake.capabilities.delete(id); }

  async setCapabilityValue(id: string, value: unknown): Promise<void> {
    if (!this.fake.capabilities.has(id)) throw new Error(`Invalid Capability: ${id}`);
    this.fake.capabilities.set(id, value);
    this.fake.writes.push({ capability: id, value });
  }

  /**
   * THROWS on a capability the device does not have, as the SDK does. A fake
   * that accepted any listener hid the one ordering that matters: a capability
   * added in a release reaches an already-paired device only through
   * `reconcileCapabilities` (platform §18), so a listener registered before that
   * runs fails `onInit` on every device paired before the release.
   */
  registerCapabilityListener(id: string, fn: (value: unknown, opts?: unknown) => unknown): void {
    if (!this.fake.capabilities.has(id)) throw new Error(`Invalid Capability: ${id}`);
    this.fake.listeners.set(id, fn);
  }

  /** `{}` for a capability nothing narrowed — including one `addCapability` added. */
  getCapabilityOptions(id: string): Record<string, unknown> {
    if (!this.fake.capabilities.has(id)) throw new Error(`Invalid Capability: ${id}`);
    return this.fake.capabilityOptions.get(id) ?? {};
  }
  async setCapabilityOptions(id: string, options: Record<string, unknown>): Promise<void> {
    if (!this.fake.capabilities.has(id)) throw new Error(`Invalid Capability: ${id}`);
    this.fake.capabilityOptions.set(id, structuredClone(options));
  }

  getAvailable(): boolean { return this.fake.available; }
  async setAvailable(): Promise<void> {
    this.fake.available = true;
    this.fake.unavailableMessage = null;
    this.fake.availability.push(true);
  }
  async setUnavailable(message?: string): Promise<void> {
    this.fake.available = false;
    this.fake.unavailableMessage = message ?? '';
    this.fake.availability.push(message ?? '');
  }

  async setWarning(message: string | null): Promise<void> {
    this.fake.warning = message;
    this.fake.warnings.push(message);
  }
  async unsetWarning(): Promise<void> {
    this.fake.warning = null;
    this.fake.warnings.push(null);
  }

  async onInit(): Promise<void> { /* overridden */ }
  async onRenamed(): Promise<void> { /* overridden */ }
  async onDeleted(): Promise<void> { /* overridden */ }
  async onUninit(): Promise<void> { /* overridden */ }
}

/** What `import Homey from 'homey'` sees. */
const sdk = { App, Driver, Device };
export default sdk;

// ------------------------------------------------------------ `this.homey`

/** A Flow card as the app registers on it: the listeners, captured. */
export class FakeFlowCard {
  run: ((args: unknown, state?: unknown) => unknown) | null = null;
  readonly autocomplete = new Map<string, (query: string, args?: unknown) => unknown>();

  constructor(readonly kind: 'action' | 'condition' | 'trigger', readonly id: string) {}

  registerRunListener(fn: (args: unknown, state?: unknown) => unknown): this {
    this.run = fn;
    return this;
  }

  registerArgumentAutocompleteListener(name: string, fn: (query: string, args?: unknown) => unknown): this {
    this.autocomplete.set(name, fn);
    return this;
  }

  /** Fire the run listener, as the Flow engine would. Throws if none. */
  async fire(args: unknown, state?: unknown): Promise<unknown> {
    if (!this.run) throw new Error(`nothing listens on the ${this.kind} card "${this.id}"`);
    return this.run(args, state);
  }

  /** Ask one argument's autocomplete, as the Flow editor would. */
  async complete(name: string, query: string, args?: unknown): Promise<unknown> {
    const fn = this.autocomplete.get(name);
    if (!fn) throw new Error(`no autocomplete for "${name}" on "${this.id}"`);
    return fn(query, args);
  }
}

export interface FakeFlow {
  getActionCard(id: string): FakeFlowCard;
  getConditionCard(id: string): FakeFlowCard;
  getTriggerCard(id: string): FakeFlowCard;
  /** Every card anything asked for, by `kind:id`. */
  readonly cards: Map<string, FakeFlowCard>;
  card(kind: FakeFlowCard['kind'], id: string): FakeFlowCard;
}

export interface FakeSettings {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  unset(key: string): void;
  getKeys(): string[];
  readonly values: Map<string, unknown>;
}

export interface FakeHomey {
  __(key: string, tokens?: Record<string, unknown>): string;
  app: any;
  clock: { getTimezone(): string };
  manifest: { id: string; version: string; drivers?: unknown[] } & Record<string, unknown>;
  settings: FakeSettings;
  timers: FakeTimers;
  setTimeout(fn: () => void, ms: number): any;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): any;
  clearInterval(handle: unknown): void;
  flow: FakeFlow;
  geolocation: { getLatitude(): number; getLongitude(): number };
  api: { getLocalUrl(): Promise<string> };
}

export interface FakeHomeyOptions {
  app?: unknown;
  /** A zone name, or a function that throws, or `null` for "the clock throws". */
  timezone?: string | (() => string) | null;
  /** Where the Homey is. `'throws'` is the missing-permission case (platform §16). */
  location?: { latitude: number; longitude: number } | 'throws';
  settings?: Record<string, unknown>;
  timers?: FakeTimers;
  manifest?: Record<string, unknown>;
}

/** The generated manifest, which is what `homey.manifest` is on a Homey. */
function realManifest(): FakeHomey['manifest'] {
  return JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8')) as FakeHomey['manifest'];
}

/**
 * A `this.homey` for an app, a driver or a device.
 *
 * Timers are a `FakeTimers`, so nothing a test starts can keep the process
 * alive — and so a test can advance past the credential fan-out's 250 ms.
 */
export function fakeHomey(options: FakeHomeyOptions = {}): FakeHomey {
  const timers = options.timers ?? new FakeTimers(Date.parse('2026-09-23T10:00:00Z'));
  const values = new Map(Object.entries(options.settings ?? {}));
  const cards = new Map<string, FakeFlowCard>();
  const card = (kind: FakeFlowCard['kind'], id: string) => {
    const key = `${kind}:${id}`;
    let found = cards.get(key);
    if (!found) {
      found = new FakeFlowCard(kind, id);
      cards.set(key, found);
    }
    return found;
  };

  const timezone = options.timezone === undefined ? 'Europe/Copenhagen' : options.timezone;
  const location = options.location ?? { latitude: 55.68, longitude: 12.57 };

  return {
    __: (key, tokens) => translate(key, tokens),
    app: options.app,
    clock: {
      getTimezone: () => {
        if (timezone === null) throw new Error('the clock has no timezone');
        return typeof timezone === 'function' ? timezone() : timezone;
      },
    },
    manifest: { ...realManifest(), ...(options.manifest ?? {}) },
    settings: {
      values,
      get: key => values.get(key) ?? null,
      set: (key, value) => { values.set(key, value); },
      unset: key => { values.delete(key); },
      getKeys: () => [...values.keys()],
    },
    timers,
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeout: handle => timers.clearTimeout(handle),
    setInterval: (fn, ms) => timers.setInterval(fn, ms),
    clearInterval: handle => timers.clearInterval(handle),
    flow: {
      cards,
      card,
      getActionCard: id => card('action', id),
      getConditionCard: id => card('condition', id),
      getTriggerCard: id => card('trigger', id),
    },
    geolocation: {
      getLatitude: () => {
        if (location === 'throws') throw new Error('Missing permission: homey:manager:geolocation');
        return location.latitude;
      },
      getLongitude: () => {
        if (location === 'throws') throw new Error('Missing permission: homey:manager:geolocation');
        return location.longitude;
      },
    },
    api: { getLocalUrl: async () => 'http://127.0.0.1:80' },
  };
}

// ------------------------------------------------------------ builders

/**
 * Construct an SDK subclass the way Homey does: no arguments, then `homey`.
 *
 * Typed by the constructor rather than the instance, so an entry point loaded
 * with `require` — which is `any`, because it is `module.exports = class` —
 * hands back `any` rather than the bare base class, and a test can call
 * `onPair` on it without a cast at every call site.
 */
export function makeApp<C extends new () => App>(Cls: C, homey: FakeHomey): InstanceType<C> {
  const app = new Cls() as InstanceType<C>;
  app.homey = homey;
  homey.app ??= app;
  return app;
}

export function makeDriver<C extends new () => Driver>(Cls: C, homey: FakeHomey): InstanceType<C> {
  const driver = new Cls() as InstanceType<C>;
  driver.homey = homey;
  return driver;
}

export interface FakeDeviceOptions {
  id: string;
  name?: string;
  store?: Record<string, unknown>;
  /** Capability ids, or id -> value. */
  capabilities?: string[] | Record<string, unknown>;
  /** Capability id -> options, as a driver's `capabilitiesOptions` gives a device it pairs. */
  capabilityOptions?: Record<string, Record<string, unknown>>;
  available?: boolean;
}

/**
 * A device instance with its recorded state, before `onInit` — call that
 * yourself, because WHEN it runs relative to the store is usually the test.
 */
export function makeDevice<C extends new () => Device>(
  Cls: C, homey: FakeHomey, options: FakeDeviceOptions,
): InstanceType<C> {
  const device = new Cls() as InstanceType<C>;
  device.homey = homey;
  const capabilities = Array.isArray(options.capabilities)
    ? new Map(options.capabilities.map(id => [id, null] as [string, unknown]))
    : new Map(Object.entries(options.capabilities ?? {}));
  device.fake = {
    data: { id: options.id },
    name: options.name ?? options.id,
    store: new Map(Object.entries(options.store ?? {})),
    capabilities,
    available: options.available ?? true,
    unavailableMessage: null,
    availability: [],
    writes: [],
    storeWrites: [],
    listeners: new Map(),
    capabilityOptions: new Map(Object.entries(options.capabilityOptions ?? {})),
    failStoreWrites: new Set(),
    warning: null,
    warnings: [],
  };
  return device;
}

// ------------------------------------------------------------ pair session

/**
 * A pair or repair session: the handlers a driver registers, and a way to call
 * them the way a pairing view does.
 *
 * `call` goes through the handler the driver registered — which, for every
 * driver here, is `handlerRegistrar`'s wrapper — so a test that calls a handler
 * exercises the same fail-loud logging a real session does.
 */
export class FakePairSession {
  readonly handlers = new Map<string, (...args: any[]) => unknown>();
  /** Everything the driver pushed to the view with `session.emit`. */
  readonly emitted: Array<{ event: string; data: unknown }> = [];
  readonly shown: string[] = [];

  setHandler(name: string, fn: (...args: any[]) => unknown): void {
    this.handlers.set(name, fn);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  async call<T = any>(name: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(name);
    if (!fn) throw new Error(`the driver registered no "${name}" handler`);
    return await fn(...args) as T;
  }

  async emit(event: string, data?: unknown): Promise<void> {
    this.emitted.push({ event, data });
  }

  async showView(view: string): Promise<void> {
    this.shown.push(view);
  }
}
