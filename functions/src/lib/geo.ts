/**
 * Geofence maths and validation of the geo-tags the app sends.
 */
import { Config } from '../config';
import { badRequest, requireNumber } from './errors';
import type { AttendanceFlag, GeoPoint, SiteDoc } from '../types';

const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres (haversine).
 *
 * Accurate to well under a metre at geofence scale, which is far finer than
 * the GPS fix it is applied to.
 */
export function distanceMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

/**
 * Parses and sanity-checks the geo-tag from the client.
 *
 * The client controls these numbers, so they are validated as untrusted
 * input — a fabricated position is still possible (a rooted phone can lie to
 * the OS), which is exactly why device binding and the flag/exception
 * workflow exist rather than a hard allow/deny.
 */
export function parseGeoPoint(value: unknown, field = 'location'): GeoPoint {
  if (typeof value !== 'object' || value === null) {
    throw badRequest('Your location could not be read. Please try again.');
  }
  const raw = value as Record<string, unknown>;

  // Accept both the Dart `toJson` spelling (accuracy_m) and camelCase.
  const accuracyRaw = raw.accuracyMeters ?? raw.accuracy_m ?? raw.accuracy;
  const capturedRaw = raw.capturedAt ?? raw.timestamp;

  const latitude = requireNumber(raw.latitude, `${field}.latitude`, {
    min: -90,
    max: 90,
  });
  const longitude = requireNumber(raw.longitude, `${field}.longitude`, {
    min: -180,
    max: 180,
  });
  const accuracyMeters = requireNumber(accuracyRaw, `${field}.accuracy`, {
    min: 0,
    max: 100_000,
  });

  const capturedAt =
    typeof capturedRaw === 'string' && !Number.isNaN(Date.parse(capturedRaw))
      ? new Date(capturedRaw).toISOString()
      : new Date().toISOString();

  return { latitude, longitude, accuracyMeters, capturedAt };
}

export interface GeofenceEvaluation {
  /** Metres from the site centre, or null when no site was matched. */
  distanceMeters: number | null;
  /** Inside the radius (plus tolerance)? Null when no site was matched. */
  inside: boolean | null;
  flags: AttendanceFlag[];
}

/**
 * Judges a geo-tag against a site.
 *
 * Note the ordering: a poor GPS fix is reported as `low_gps_accuracy` and
 * suppresses the `outside_geofence` flag. Flagging someone for being out of
 * bounds on a ±400 m fix would be noise, and noisy flags get ignored, which
 * defeats the point of having them.
 */
export function evaluateGeofence(
  point: GeoPoint,
  site: SiteDoc | null,
): GeofenceEvaluation {
  const flags: AttendanceFlag[] = [];
  const unreliableFix = point.accuracyMeters > Config.geofence.maxAccuracyMeters;

  if (unreliableFix) {
    flags.push('low_gps_accuracy');
  }

  if (!site) {
    return { distanceMeters: null, inside: null, flags };
  }

  const metres = distanceMeters(
    point.latitude,
    point.longitude,
    site.latitude,
    site.longitude,
  );

  const radius =
    (site.radiusMeters || Config.geofence.defaultRadiusMeters) +
    Config.geofence.toleranceMeters;

  const inside = metres <= radius;
  if (!inside && !unreliableFix) {
    flags.push('outside_geofence');
  }

  return { distanceMeters: Math.round(metres), inside, flags };
}

/**
 * Picks the site the employee is most likely at.
 *
 * Their assigned site wins if they are anywhere near it; otherwise we take
 * the nearest active site, so that someone temporarily deployed elsewhere
 * gets a sensible record rather than a bare "outside geofence".
 */
export function chooseNearestSite(
  point: GeoPoint,
  sites: SiteDoc[],
  assignedSiteId: string | null,
): SiteDoc | null {
  const active = sites.filter((s) => s.active);
  if (active.length === 0) return null;

  const withDistance = active.map((site) => ({
    site,
    metres: distanceMeters(
      point.latitude,
      point.longitude,
      site.latitude,
      site.longitude,
    ),
  }));

  const assigned = withDistance.find((s) => s.site.siteId === assignedSiteId);
  if (assigned) {
    const radius =
      (assigned.site.radiusMeters || Config.geofence.defaultRadiusMeters) +
      Config.geofence.toleranceMeters;
    if (assigned.metres <= radius) return assigned.site;
  }

  withDistance.sort((a, b) => a.metres - b.metres);
  return withDistance[0]?.site ?? assigned?.site ?? null;
}

/**
 * Flags a device clock that disagrees with ours.
 *
 * All stored timestamps are server-side, so skew cannot shift a record — but
 * a phone hours out of step is worth surfacing, since it often means someone
 * has been changing the clock deliberately.
 */
export function clockSkewFlags(point: GeoPoint, now: Date): AttendanceFlag[] {
  const flags: AttendanceFlag[] = [];
  const capturedMs = Date.parse(point.capturedAt);
  if (Number.isNaN(capturedMs)) return flags;

  const skewMinutes = Math.abs(now.getTime() - capturedMs) / 60_000;
  if (skewMinutes > Config.attendance.maxClockSkewMinutes) {
    flags.push('clock_skew');
  }
  if (capturedMs < now.getTime() - Config.attendance.lateSyncMinutes * 60_000) {
    flags.push('late_sync');
  }
  return flags;
}
