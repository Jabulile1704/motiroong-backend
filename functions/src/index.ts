/**
 * MoTiroong backend — Cloud Functions entrypoint.
 *
 * Everything the mobile app calls is an `onCall` callable rather than an
 * HTTP endpoint. That choice is what lets `lib/network/auth_interceptor.dart`
 * disappear: the Firebase SDK attaches and refreshes the ID token itself, so
 * there is no bearer header to manage, no refresh-token dance, and no
 * `ApiEndpoints.baseUrl` to point at a server.
 *
 * Every export below becomes a deployed function, so the grouping here is
 * also the deployment surface — `firebase deploy --only functions:clockIn`
 * works on any name in this file.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { Config } from './config';
import { closeStaleShifts } from './attendance/clock';

// ----------------------------------------------------------------- auth
export {
  createEmployeeProfile,
  cancelSignUp,
  updateMyProfile,
  enforceSignUpDomain,
} from './auth/signup';

export {
  approveEmployee,
  rejectEmployee,
  setEmployeeStatus,
  setEmployeeRole,
  listPendingEmployees,
} from './auth/approval';

export {
  enrollDevice,
  signInWithDevice,
  listDevices,
  revokeDevice,
  getMyProfile,
} from './auth/device';

// ----------------------------------------------------------- attendance
export {
  clockIn,
  clockOut,
  getClockStatus,
  getAttendanceHistory,
  getAttendanceRecord,
} from './attendance/clock';

export { listSites, upsertSite, archiveSite } from './attendance/sites';

// ----------------------------------------------------------- exceptions
export {
  submitException,
  listMyExceptions,
  listPendingExceptions,
  reviewException,
} from './exceptions/exceptions';

// ------------------------------------------------------------ scheduled

/**
 * Closes shifts left open overnight.
 *
 * Runs at 02:00 SAST, after the late shift has ended and before the early
 * shift starts, so nobody's real shift is truncated by the sweep.
 */
export const closeStaleShiftsNightly = onSchedule(
  {
    region: Config.region,
    schedule: '0 2 * * *',
    timeZone: 'Africa/Johannesburg',
    retryCount: 2,
  },
  async () => {
    const closed = await closeStaleShifts();
    console.log(`closeStaleShiftsNightly: closed ${closed} stale shift(s)`);
  },
);
