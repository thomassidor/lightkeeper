/** Internal control flow: cancellation is neither a lamp failure nor a success. */
export class WriteCancelled extends Error {
  constructor() { super('write is no longer eligible'); }
}
