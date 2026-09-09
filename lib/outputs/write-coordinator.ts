import { KeyedMutex } from '../support/keyed-mutex';

/** Shared by all runtimes using one Homey client. */
export class WriteCoordinator {
  private readonly devices = new KeyedMutex();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly concurrency = 8) {}

  async run<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    return this.devices.run(deviceId, async () => {
      if (this.active >= this.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
      else this.active += 1;
      try { return await operation(); }
      finally {
        const next = this.waiting.shift();
        if (next) next();
        else this.active -= 1;
      }
    });
  }
}
