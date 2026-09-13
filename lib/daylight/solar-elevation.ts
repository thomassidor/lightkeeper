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
 * equation of time → true solar time → hour angle → elevation → azimuth.
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

/** Where the sun is on its orbit, on a given day. Shared, so it cannot drift. */
interface OrbitalTerms {
  /** Degrees north of the celestial equator, ±23.44 over a year. */
  declination: number;
  /** Minutes the real sun runs ahead of or behind the clock, up to about ±16. */
  equationOfTime: number;
}

/**
 * The two terms both public functions need, from one pass of the NOAA sequence.
 *
 * Extracted rather than duplicated because `sunTimes` needs exactly the same
 * declination and equation of time that `solarPosition` does, and two copies of
 * sixty lines of trigonometry is two places for a sign error to live in only
 * one of them — which would present as sunrise and elevation disagreeing about
 * where the sun is, on a screen that draws both at once.
 */
function orbitalTerms(atMs: number): OrbitalTerms {
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

  return { declination, equationOfTime };
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
  return solarPosition(latitude, longitude, atMs).elevation;
}

/** Where the sun is: how high, and which way round. */
export interface SolarPosition {
  /** Degrees above the horizon, −90 … +90. Negative below it. */
  elevation: number;
  /**
   * Degrees CLOCKWISE FROM NORTH, 0 … 360. 90 is due east, 180 due south.
   *
   * Needed because elevation alone is symmetric about solar noon, so it cannot
   * tell an east-facing room from a west-facing one — 08:00 and 16:00 look
   * identical to it. Which way the sun is round is the only thing that can.
   */
  azimuth: number;
}

/**
 * Elevation AND azimuth, from one pass of the algorithm.
 *
 * One function rather than two because everything above the last four lines is
 * shared: computing them separately would run the whole NOAA sequence twice and
 * give two places for it to drift.
 */
export function solarPosition(latitude: number, longitude: number, atMs: number): SolarPosition {
  const { declination, equationOfTime } = orbitalTerms(atMs);


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
  const zenith = degrees(Math.acos(Math.min(1, Math.max(-1, cosZenith))));

  /**
   * Azimuth, in NOAA's published form.
   *
   * The denominator vanishes when the sun is exactly overhead or the observer is
   * exactly at a pole; there is no meaningful bearing then, so it takes the
   * hemisphere's noon direction rather than dividing by nearly zero. 0.001 is
   * NOAA's own guard value.
   */
  let azimuth: number;
  const denominator = Math.cos(radians(latitude)) * Math.sin(radians(zenith));
  if (Math.abs(denominator) > 0.001) {
    const ratio = (Math.sin(radians(latitude)) * Math.cos(radians(zenith))
      - Math.sin(radians(declination))) / denominator;
    azimuth = 180 - degrees(Math.acos(Math.min(1, Math.max(-1, ratio))));
    // Before noon the sun is east of the meridian, after it west.
    if (hourAngle > 0) azimuth = -azimuth;
  } else {
    azimuth = latitude > 0 ? 180 : 0;
  }

  return { elevation: 90 - zenith, azimuth: (azimuth + 360) % 360 };
}

/**
 * The altitude a sunrise is declared at, in degrees.
 *
 * −0.833, not 0, and this is the one place in the file where refraction IS
 * applied. The header explains why it is left out of `solarElevation`: the
 * elevation ramp's dark end is civil twilight at −6°, and half a degree against
 * six is noise. A sunrise TIME is the opposite case. It is a clock time shown to
 * a person on a screen, next to the one their weather app shows, and the
 * geometric horizon puts it three to four minutes out — visibly wrong, for no
 * gain. The figure is the standard one: 34 arcminutes of refraction plus the
 * sun's own 16-arcminute radius, because sunrise is the first limb, not the
 * centre.
 */
const SUNRISE_ALTITUDE = -0.833;

/** When the sun rises, sets and is highest, for one day at one place. */
export interface SunTimes {
  /** When the sun is due south (or north). Defined every day, everywhere. */
  solarNoonMs: number;
  /**
   * When the sun crosses `SUNRISE_ALTITUDE`, or `null` inside a polar day or
   * night where it never does.
   *
   * Null is not an error and must not be treated as one: above the Arctic
   * Circle it is the correct answer for weeks at a time, and a circadian light
   * there needs the fixed-clock fallback rather than a refusal to run.
   */
  sunriseMs: number | null;
  sunsetMs: number | null;
  /**
   * Which polar case `null` means: the sun never set, or never rose.
   *
   * Only meaningful when `sunriseMs` is null, and it is what lets a caller pick
   * a sensible fallback rather than the same one for both — a Tromsø midsummer
   * and a Tromsø midwinter want opposite answers.
   */
  alwaysUp: boolean;
}

/**
 * Sunrise, sunset and solar noon for the UTC day containing `atMs`.
 *
 * **Why this is not just a search over `solarElevation`.** Sampling the
 * elevation minute by minute and looking for a sign change would be 1,440 runs
 * of the whole NOAA sequence per device per day, and would still need a special
 * case for the polar day it would never find a crossing in. The hour-angle
 * solution below is closed-form: one pass for the day's terms, one `acos`, and
 * the polar case falls out of that `acos` having no solution.
 *
 * **The UTC day, deliberately.** A caller asking on the far side of local
 * midnight from UTC gets the neighbouring day's sunrise. That is a difference of
 * one day's drift — under four minutes at temperate latitudes, and the boundary
 * it is wanted for is then stepped by the user in quarter hours. Making it
 * timezone-aware would put an `Intl` lookup into a file whose whole claim is
 * that it is pure arithmetic checkable against a published table.
 */
export function sunTimes(latitude: number, longitude: number, atMs: number): SunTimes {
  const dayStartMs = Math.floor(atMs / MS_PER_DAY) * MS_PER_DAY;
  // The terms are evaluated at this place's own solar noon rather than at UTC
  // noon: the declination moves by up to 0.4° a day near an equinox, and
  // evaluating twelve hours out would put sunrise a minute out with it.
  const { declination, equationOfTime } =
    orbitalTerms(dayStartMs + MS_PER_DAY / 2 - longitude * 4 * 60_000);

  // 720 is noon in minutes; four minutes per degree of longitude, and the
  // equation of time is how far the real sun is running from the mean one.
  const solarNoonMinutes = 720 - 4 * longitude - equationOfTime;
  const solarNoonMs = dayStartMs + solarNoonMinutes * 60_000;

  const cosHourAngle =
    (Math.cos(radians(90 - SUNRISE_ALTITUDE))
      - Math.sin(radians(latitude)) * Math.sin(radians(declination)))
    / (Math.cos(radians(latitude)) * Math.cos(radians(declination)));

  // No solution means the sun never reaches that altitude, in either direction.
  // Above 1 the horizon is never reached going up — polar night; below −1 it is
  // never reached coming down — midnight sun.
  if (!Number.isFinite(cosHourAngle) || cosHourAngle > 1 || cosHourAngle < -1) {
    return {
      solarNoonMs,
      sunriseMs: null,
      sunsetMs: null,
      alwaysUp: cosHourAngle < 0,
    };
  }

  const halfDayMinutes = 4 * degrees(Math.acos(cosHourAngle));
  return {
    solarNoonMs,
    sunriseMs: solarNoonMs - halfDayMinutes * 60_000,
    sunsetMs: solarNoonMs + halfDayMinutes * 60_000,
    alwaysUp: false,
  };
}
