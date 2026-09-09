/** The one seam between anything that PRODUCES evidence and whatever consumes it.
 *
 * It lives here, alone in a file of its own, so that the producers — the two
 * tick-driven runtimes, their managers, the lux service and the control history
 * — depend on a signature rather than on the recorder that happens to implement
 * it today. The recorder is an opt-in feature that can be absent, replaced or
 * removed; a runtime must not import from it to describe its own dependency.
 *
 * `unknown` on the payload is deliberate: the recorder validates, strips and
 * redacts every record on its way to disk, so a producer neither knows nor
 * needs to know the record shape it will be written as.
 */
export type EvidenceSink = (type: string, data: unknown) => void;
