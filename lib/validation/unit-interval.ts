/**
 * A number on the 0–1 axis, or nothing.
 *
 * Both feature modules had a private `sanitiseUnit` with the same body, and both
 * are about the same axis: brightness is perceptual 0–1, and colour temperature
 * is normalised 0–1 with 1 the WARMEST end (CLAUDE.md §6). Clamping rather than
 * rejecting is deliberate — a slider that reports 1.0000001 is a slider at
 * maximum, not a malformed request.
 *
 * What is NOT here is what "0" means, because the two features disagree and both
 * are right: a brightness of 0 is "on, at nothing" and is treated as unset,
 * while a temperature of 0 is the coolest end of the axis and is meaningful. That
 * policy stays with the feature that owns it.
 */
export function sanitiseUnitInterval(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}
