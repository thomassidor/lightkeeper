/**
 * Where the sun is, from a latitude, a longitude and an instant.
 *
 * Pure, with no Homey imports and no network, for the same reason
 * lib/circadian/circadian-curve.ts is: it is the whole correctness of the
 * daylight feature in about seventy lines, and every one of them is provable
 * against values a textbook agrees with.
 *
 * **Why the app computes this at all.** SDK v3 has no solar helper and no
 * manager will answer "how high is the sun" (platform §16). Homey's own
 * `homey:manager:cron:sunrise` and `:sunset` are TRIGGER CARDS — they fire, they
 * do not answer a question — so they cannot supply a number to interpolate
 * against (platform §9). What is available is `this.homey.geolocation`, which
 * gives a latitude and a longitude and nothing else, and the arithmetic below.
 *
 * This is the standard NOAA solar-position algorithm, the same one the NOAA
 * calculator uses, in its published order: Julian day → mean longitude and
 * anomaly → equation of centre → apparent longitude → obliquity → declination →
 * equation of time → true solar time → hour angle → elevation.
 *
 * **Everything here is UTC**, deliberately. The instant is a millisecond count
 * and the longitude carries the rest; no timezone, no DST, no `Intl`. That is
 * the opposite of lib/time/local-clock.ts, and both are right — a schedule fires
 * at a wall-clock time a person chose, while the sun does not care what a clock
 * in this house says.
 *
 * Atmospheric refraction is NOT applied. It matters at the horizon (about half a
 * degree, which is why sunrise tables need it) and this feature reads a ramp
 * whose dark end is civil twilight at −6°, six times that error. Adding it would
 * be arithmetic nobody could check against the docblock above.
 */

const DEG = Math.PI / 180;
const MS_PER_DAY = 86_400_000;
/** Julian day number at the Unix epoch. */
const JULIAN_EPOCH = 2_440_587.5;
const JULIAN_J2000 = 2_451_545;
const DAYS_PER_CENTURY = 36_525;

function radians(degrees: number): number {
  return degrees * DEG;
}

function degrees(radians: number): number {
  return radians / DEG;
}

/**
 * The sun's elevation above the horizon, in DEGREES. Negative below it.
 *
 * Range is −90 … +90. Callers get a number for any input in range; deciding
 * whether there IS a latitude to pass is the caller's job — see `usableLocation`
 * in lib/daylight/daylight-types.ts, which is where a Homey that has never been
 * told where it is gets refused.
 */
export function solarElevation(latitude: number, longitude: number, atMs: number): number {
  const century = (atMs / MS_PER_DAY + JULIAN_EPOCH - JULIAN_J2000) / DAYS_PER_CENTURY;

  // Geometric mean longitude and mean anomaly of the sun, degrees.
  const meanLongitude = (280.46646 + century * (36000.76983 + century * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + century * (35999.05029 - 0.0001537 * century);

  // Eccentricity of the earth's orbit, and the correction it forces on a mean
  // longitude that assumed a circle.
  const eccentricity = 0.016708634 - century * (0.000042037 + 0.0000001267 * century);
  const equationOfCentre =
    Math.sin(radians(meanAnomaly)) * (1.914602 - century * (0.004817 + 0.000014 * century))
    + Math.sin(radians(2 * meanAnomaly)) * (0.019993 - 0.000101 * century)
    + Math.sin(radians(3 * meanAnomaly)) * 0.000289;

  // Nutation and aberration, as one term. `omega` is the moon's ascending node.
  const omega = 125.04 - 1934.136 * century;
  const apparentLongitude =
    meanLongitude + equationOfCentre - 0.00569 - 0.00478 * Math.sin(radians(omega));

  // Obliquity of the ecliptic — the earth's tilt, ~23.44° and shrinking.
  const meanObliquity =
    23 + (26 + (21.448 - century * (46.815 + century * (0.00059 - century * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(radians(omega));

  const declination = degrees(Math.asin(
    Math.sin(radians(obliquity)) * Math.sin(radians(apparentLongitude)),
  ));

  // The equation of time, in MINUTES: how far ahead of or behind the clock the
  // real sun runs. Up to about ±16 minutes, and the reason a sundial and a watch
  // disagree in February.
  const y = Math.tan(radians(obliquity / 2)) ** 2;
  const equationOfTime = 4 * degrees(
    y * Math.sin(2 * radians(meanLongitude))
    - 2 * eccentricity * Math.sin(radians(meanAnomaly))
    + 4 * eccentricity * y * Math.sin(radians(meanAnomaly)) * Math.cos(2 * radians(meanLongitude))
    - 0.5 * y * y * Math.sin(4 * radians(meanLongitude))
    - 1.25 * eccentricity * eccentricity * Math.sin(2 * radians(meanAnomaly)),
  );

  // Minutes past UTC midnight, fractional. Taken off the instant directly rather
  // than through a Date's local accessors, which would put the host's timezone
  // into a calculation that has no business knowing it.
  const minutesUtc = ((atMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY / 60_000;

  // 4 minutes per degree of longitude: the earth turns 15° an hour.
  const trueSolarMinutes = (minutesUtc + equationOfTime + 4 * longitude + 1440) % 1440;
  // 0 minutes is midnight, so noon (720) is an hour angle of zero.
  const hourAngle = trueSolarMinutes / 4 - 180;

  const cosZenith =
    Math.sin(radians(latitude)) * Math.sin(radians(declination))
    + Math.cos(radians(latitude)) * Math.cos(radians(declination)) * Math.cos(radians(hourAngle));

  // Clamped before acos: at the poles the two terms can sum to 1.0000000000000002
  // and acos of that is NaN, which propagates all the way to a lamp being sent
  // nothing at all.
  return 90 - degrees(Math.acos(Math.min(1, Math.max(-1, cosZenith))));
}
