/**
 * The Firestore document shapes, in one place.
 *
 * These mirror the Dart models in the mobile app
 * (`lib/features/<feature>/data/models/`). Field names are camelCase here and
 * in Firestore; the Dart side maps them explicitly in `fromJson`/`toJson`,
 * so if you rename a field, change both.
 */

import { Timestamp } from 'firebase-admin/firestore';

/** Where an employee is in the approval workflow. */
export type EmployeeStatus =
  /** Signed up, waiting for an admin. Cannot clock in or read sites. */
  | 'pending'
  /** Approved and able to use the app. */
  | 'active'
  /** Was active, now blocked (left the organisation, under investigation). */
  | 'suspended'
  /** Sign-up was turned down. */
  | 'rejected';

export type EmployeeRole = 'employee' | 'supervisor' | 'admin';

/** `employees/{uid}` */
export interface EmployeeDoc {
  uid: string;
  /** Human-facing staff number, e.g. `EMP-0042`. Unique among employees. */
  employeeId: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: EmployeeRole;
  status: EmployeeStatus;
  /** Home site — the geofence this employee normally clocks in at. */
  siteId: string | null;
  /** Department/section as captured at sign-up, for the admin to verify. */
  department: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Set when an admin approves or rejects. */
  reviewedAt: Timestamp | null;
  reviewedBy: string | null;
  /** Populated on rejection or suspension so the app can explain why. */
  statusReason: string | null;
}

/** `employees/{uid}/devices/{deviceId}` — a biometric-bound device. */
export interface DeviceDoc {
  deviceId: string;
  uid: string;
  /** SHA-256 of the device secret. The secret itself never reaches us. */
  secretHash: string;
  /** `ios` | `android` — for display in "your devices". */
  platform: string;
  /** e.g. "iPhone 15 Pro" — so a user can tell two devices apart. */
  model: string;
  /**
   * Which sensor the user enrolled with: `face`, `fingerprint`, `iris`, or
   * `unknown`. Recorded for the audit trail only — we never see biometric
   * data, just the OS's yes/no.
   */
  biometricType: string;
  /**
   * How this device unlocks its secret: the OS biometric prompt, or a PIN the
   * server checks. Documents written before PIN support have no field and are
   * biometric.
   */
  method?: 'biometric' | 'pin';
  /** `hashPin(secret, pin)` for PIN devices, null otherwise. */
  pinHash?: string | null;
  enrolledAt: Timestamp;
  lastUsedAt: Timestamp | null;
  revokedAt: Timestamp | null;
  /** Consecutive failed secret presentations; locks the device at 5. */
  failedAttempts: number;
}

/** `sites/{siteId}` — a geofence. */
export interface SiteDoc {
  siteId: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  /** Geofence radius. Clock events outside this are flagged, not refused. */
  radiusMeters: number;
  active: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** A geo-tag as captured by the phone. Mirrors Dart `LocationResult`. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  /** ISO-8601 from the device clock — untrusted, kept for the audit trail. */
  capturedAt: string;
}

/**
 * Why a clock event was flagged. A flagged event is still recorded — the
 * employee may have a good reason — but it surfaces to a supervisor and the
 * employee can attach an explanation via `submitException`.
 */
export type AttendanceFlag =
  /** Outside the site's radius. */
  | 'outside_geofence'
  /** GPS accuracy too poor to trust the position. */
  | 'low_gps_accuracy'
  /** Device clock disagrees with the server by more than the tolerance. */
  | 'clock_skew'
  /** Submitted from the offline queue well after the fact. */
  | 'late_sync'
  /**
   * Signed in without a device-verified session — password fallback rather
   * than Face ID, fingerprint or PIN.
   */
  | 'no_biometric'
  /** Shift ran past the maximum, so clock-out was forced. */
  | 'auto_closed';

/** `attendance/{recordId}` */
export interface AttendanceDoc {
  recordId: string;
  uid: string;
  employeeId: string;
  siteId: string | null;
  /** `open` between clock-in and clock-out, then `closed`. */
  status: 'open' | 'closed';

  clockInAt: Timestamp;
  clockInLocation: GeoPoint;
  /** Metres from the site centre at clock-in; null when site unknown. */
  clockInDistanceMeters: number | null;
  clockInDeviceId: string | null;
  clockInBiometric: boolean;

  clockOutAt: Timestamp | null;
  clockOutLocation: GeoPoint | null;
  clockOutDistanceMeters: number | null;
  clockOutDeviceId: string | null;
  clockOutBiometric: boolean;

  /** Worked minutes, computed server-side on clock-out. */
  durationMinutes: number | null;
  flags: AttendanceFlag[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type ExceptionStatus = 'pending' | 'approved' | 'rejected';

/** `exceptions/{exceptionId}` — an employee's explanation of a flagged event. */
export interface ExceptionDoc {
  exceptionId: string;
  uid: string;
  employeeId: string;
  /** The attendance record being explained, when there is one. */
  attendanceId: string | null;
  /**
   * `late_arrival`, `early_leave`, `absence`, `missed_clock_in`,
   * `missed_clock_out`, `outside_geofence`, `device_failure`, `other`.
   */
  type: string;
  /** The calendar day the request is about (`YYYY-MM-DD`), if given. */
  forDate?: string | null;
  reason: string;
  status: ExceptionStatus;
  submittedAt: Timestamp;
  reviewedAt: Timestamp | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
}

/** `auditLogs/{logId}` — append-only record of every privileged action. */
export interface AuditLogDoc {
  action: string;
  /** uid of whoever performed it, or `system` for scheduled jobs. */
  actorUid: string;
  actorEmail: string | null;
  /** What was acted on — usually an employee uid or a record id. */
  targetId: string | null;
  at: Timestamp;
  metadata: Record<string, unknown>;
}

/** The shape of the custom claims we mint. Read by firestore.rules. */
export interface MotiroongClaims {
  role: EmployeeRole;
  status: EmployeeStatus;
  employeeId: string;
}
