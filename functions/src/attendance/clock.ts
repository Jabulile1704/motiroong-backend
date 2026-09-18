/**
 * Clock in and clock out.
 *
 * Two things make these records trustworthy, and both depend on the work
 * happening here rather than in the app:
 *
 *   - **The timestamp is ours.** The app sends the geo-tag it captured, but
 *     `clockInAt` is `serverTimestamp()`. A phone with its clock wound back
 *     cannot backdate a shift; it can only earn itself a `clock_skew` flag.
 *   - **The geofence verdict is ours.** The app shows the user whether they
 *     look in range, but that display is a courtesy. The stored distance and
 *     flags are recomputed here from the site record.
 */
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { onCall } from 'firebase-functions/v2/https';

import { Config } from '../config';
import { failed, notFound, optionalString } from '../lib/errors';
import { attendanceRef, db, sitesRef } from '../lib/firebase';
import { requireActiveEmployee } from '../lib/guards';
import {
  chooseNearestSite,
  clockSkewFlags,
  evaluateGeofence,
  parseGeoPoint,
} from '../lib/geo';
import type { AttendanceDoc, AttendanceFlag, SiteDoc } from '../types';

/** Loads active sites. Small collection, so a full read is fine. */
async function loadSites(): Promise<SiteDoc[]> {
  const snapshot = await sitesRef().where('active', '==', true).get();
  return snapshot.docs.map((doc) => doc.data() as SiteDoc);
}

/** The caller's currently open shift, if any. */
async function findOpenRecord(uid: string) {
  const snapshot = await attendanceRef()
    .where('uid', '==', uid)
    .where('status', '==', 'open')
    .orderBy('clockInAt', 'desc')
    .limit(1)
    .get();
  return snapshot.empty ? null : snapshot.docs[0];
}

/**
 * Opens a shift.
 *
 * Being outside the geofence does not block the clock-in. That is a
 * deliberate policy choice: a refusal leaves an employee who is legitimately
 * off-site — a callout, a depot visit, a broken GPS — with no way to record
 * that they worked, and the usual result is a paper note that nobody
 * reconciles. Recording it with `outside_geofence` and letting them explain
 * via `submitException` keeps the data complete and puts a human in the loop.
 */
export const clockIn = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireActiveEmployee(request);
    const data = request.data ?? {};

    const point = parseGeoPoint(data.location);
    const deviceId = optionalString(data.deviceId, 128);
    // The app cannot simply assert this — it is read from the token minted by
    // signInWithDevice, so only a real biometric session can set it.
    const biometric = request.auth?.token?.biometric === true;

    const existing = await findOpenRecord(caller.uid);
    if (existing) {
      const record = existing.data() as AttendanceDoc;
      const openedMs = record.clockInAt?.toMillis() ?? 0;
      const ageSeconds = (Date.now() - openedMs) / 1000;

      // A double tap or an offline-queue replay: return the record we already
      // have instead of opening a second shift.
      if (ageSeconds < Config.attendance.duplicateWindowSeconds) {
        return { ...summarise(record), recordId: existing.id, duplicate: true };
      }
      throw failed(
        'You are already clocked in. Clock out before starting a new shift.',
      );
    }

    const sites = await loadSites();
    const site = chooseNearestSite(point, sites, caller.employee.siteId);
    const geo = evaluateGeofence(point, site);

    const now = new Date();
    const flags: AttendanceFlag[] = [
      ...geo.flags,
      ...clockSkewFlags(point, now),
    ];
    if (!biometric) flags.push('no_biometric');

    const ref = attendanceRef().doc();
    const record = {
      recordId: ref.id,
      uid: caller.uid,
      employeeId: caller.employee.employeeId,
      siteId: site?.siteId ?? null,
      status: 'open' as const,

      clockInAt: FieldValue.serverTimestamp(),
      clockInLocation: point,
      clockInDistanceMeters: geo.distanceMeters,
      clockInDeviceId: deviceId,
      clockInBiometric: biometric,

      clockOutAt: null,
      clockOutLocation: null,
      clockOutDistanceMeters: null,
      clockOutDeviceId: null,
      clockOutBiometric: false,

      durationMinutes: null,
      flags: dedupe(flags),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    await ref.set(record);

    return {
      recordId: ref.id,
      duplicate: false,
      status: 'open' as const,
      siteId: site?.siteId ?? null,
      siteName: site?.name ?? null,
      distanceMeters: geo.distanceMeters,
      insideGeofence: geo.inside,
      flags: dedupe(flags),
      clockInAt: new Date().toISOString(),
    };
  },
);

/** Closes the open shift and computes its duration from the server clocks. */
export const clockOut = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireActiveEmployee(request);
    const data = request.data ?? {};

    const point = parseGeoPoint(data.location);
    const deviceId = optionalString(data.deviceId, 128);
    const biometric = request.auth?.token?.biometric === true;

    const open = await findOpenRecord(caller.uid);
    if (!open) {
      throw failed('You are not clocked in at the moment.');
    }
    const record = open.data() as AttendanceDoc;

    const sites = await loadSites();
    const site = record.siteId
      ? (sites.find((s) => s.siteId === record.siteId) ?? null)
      : chooseNearestSite(point, sites, caller.employee.siteId);
    const geo = evaluateGeofence(point, site);

    const now = new Date();
    const clockInMs = record.clockInAt?.toMillis() ?? now.getTime();
    const durationMinutes = Math.max(
      0,
      Math.round((now.getTime() - clockInMs) / 60_000),
    );

    const flags = dedupe([
      ...record.flags,
      ...geo.flags,
      ...clockSkewFlags(point, now),
      ...(biometric ? [] : (['no_biometric'] as AttendanceFlag[])),
    ]);

    await open.ref.update({
      status: 'closed',
      clockOutAt: FieldValue.serverTimestamp(),
      clockOutLocation: point,
      clockOutDistanceMeters: geo.distanceMeters,
      clockOutDeviceId: deviceId,
      clockOutBiometric: biometric,
      durationMinutes,
      flags,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      recordId: open.id,
      status: 'closed' as const,
      durationMinutes,
      siteId: site?.siteId ?? null,
      siteName: site?.name ?? null,
      distanceMeters: geo.distanceMeters,
      insideGeofence: geo.inside,
      flags,
      clockOutAt: now.toISOString(),
    };
  },
);

/**
 * Current clock state for the home screen.
 *
 * Mirrors the Dart `ClockStatus` model.
 */
export const getClockStatus = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireActiveEmployee(request);
    const open = await findOpenRecord(caller.uid);

    if (!open) {
      return { clockedIn: false, recordId: null, since: null, siteId: null };
    }
    const record = open.data() as AttendanceDoc;
    const since = record.clockInAt?.toDate() ?? null;

    return {
      clockedIn: true,
      recordId: open.id,
      since: since?.toISOString() ?? null,
      elapsedMinutes: since
        ? Math.round((Date.now() - since.getTime()) / 60_000)
        : 0,
      siteId: record.siteId,
      flags: record.flags,
    };
  },
);

/**
 * Paged attendance history for the signed-in employee.
 *
 * The app could read `attendance/` directly — the rules permit it — but
 * going through a function keeps the shape of the response identical to the
 * clock endpoints, so the Dart model has one `fromJson` rather than two.
 */
export const getAttendanceHistory = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireActiveEmployee(request);
    const limit = Math.min(Number(request.data?.limit) || 30, 100);
    const before = optionalString(request.data?.before, 64);

    let query = attendanceRef()
      .where('uid', '==', caller.uid)
      .orderBy('clockInAt', 'desc')
      .limit(limit);

    if (before && !Number.isNaN(Date.parse(before))) {
      query = query.startAfter(Timestamp.fromDate(new Date(before)));
    }

    const snapshot = await query.get();
    return {
      records: snapshot.docs.map((doc) =>
        summarise(doc.data() as AttendanceDoc),
      ),
      hasMore: snapshot.size === limit,
    };
  },
);

/** The wire shape of an attendance record. Keep in step with the Dart model. */
function summarise(record: AttendanceDoc) {
  return {
    recordId: record.recordId,
    employeeId: record.employeeId,
    siteId: record.siteId,
    status: record.status,
    clockInAt: record.clockInAt?.toDate().toISOString() ?? null,
    clockOutAt: record.clockOutAt?.toDate().toISOString() ?? null,
    durationMinutes: record.durationMinutes,
    clockInDistanceMeters: record.clockInDistanceMeters,
    clockOutDistanceMeters: record.clockOutDistanceMeters,
    clockInBiometric: record.clockInBiometric,
    clockOutBiometric: record.clockOutBiometric,
    flags: record.flags ?? [],
  };
}

const dedupe = (flags: AttendanceFlag[]): AttendanceFlag[] => [
  ...new Set(flags),
];

/**
 * Nightly sweep that closes shifts nobody clocked out of.
 *
 * Left open, these would accumulate and block the employee's next clock-in
 * with "you are already clocked in". Closed records are marked `auto_closed`
 * so payroll can see the duration was not observed, and the employee can
 * raise an exception to correct it.
 */
export async function closeStaleShifts(): Promise<number> {
  const cutoff = Timestamp.fromMillis(
    Date.now() - Config.attendance.maxShiftHours * 3_600_000,
  );

  const stale = await attendanceRef()
    .where('status', '==', 'open')
    .where('clockInAt', '<=', cutoff)
    .limit(400)
    .get();

  if (stale.empty) return 0;

  const batch = db.batch();
  for (const doc of stale.docs) {
    const record = doc.data() as AttendanceDoc;
    batch.update(doc.ref, {
      status: 'closed',
      clockOutAt: record.clockInAt,
      durationMinutes: 0,
      flags: dedupe([...(record.flags ?? []), 'auto_closed']),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  return stale.size;
}

/** Looks up a single record. Used by the exception screen. */
export const getAttendanceRecord = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireActiveEmployee(request);
    const recordId = optionalString(request.data?.recordId, 64);
    if (!recordId) throw notFound('That attendance record does not exist.');

    const snapshot = await attendanceRef().doc(recordId).get();
    if (!snapshot.exists) {
      throw notFound('That attendance record does not exist.');
    }
    const record = snapshot.data() as AttendanceDoc;

    const isOwner = record.uid === caller.uid;
    const isReviewer = caller.role === 'admin' || caller.role === 'supervisor';
    if (!isOwner && !isReviewer) {
      throw notFound('That attendance record does not exist.');
    }

    return summarise(record);
  },
);
