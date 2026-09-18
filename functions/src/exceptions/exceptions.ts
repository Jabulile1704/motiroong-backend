/**
 * Exception requests — the human appeal path for a flagged clock event.
 *
 * Because `clockIn` records rather than refuses an out-of-bounds event, this
 * is what closes the loop: the employee explains, a supervisor decides, and
 * the decision is attached to the record for the auditor.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { onCall } from 'firebase-functions/v2/https';

import { Config } from '../config';
import { writeAudit } from '../lib/audit';
import {
  badRequest,
  failed,
  notFound,
  optionalString,
  requireString,
} from '../lib/errors';
import { attendanceRef, exceptionsRef } from '../lib/firebase';
import { requireActiveEmployee, requireRole } from '../lib/guards';
import type { AttendanceDoc, ExceptionDoc } from '../types';

const EXCEPTION_TYPES = [
  'missed_clock_in',
  'missed_clock_out',
  'outside_geofence',
  'device_failure',
  'other',
] as const;

/** Files an explanation, optionally against a specific attendance record. */
export const submitException = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireActiveEmployee(request);
    const data = request.data ?? {};

    const type = requireString(data.type, 'Request type', { max: 40 });
    if (!(EXCEPTION_TYPES as readonly string[]).includes(type)) {
      throw badRequest('Please choose a valid request type.');
    }
    const reason = requireString(data.reason, 'Reason', { min: 10, max: 1000 });
    const attendanceId = optionalString(data.attendanceId, 64);

    // Verify the record is really theirs before letting them attach to it —
    // otherwise an employee could hang an explanation off a colleague's shift.
    if (attendanceId) {
      const snapshot = await attendanceRef().doc(attendanceId).get();
      if (!snapshot.exists) {
        throw notFound('That attendance record does not exist.');
      }
      if ((snapshot.data() as AttendanceDoc).uid !== caller.uid) {
        throw notFound('That attendance record does not exist.');
      }

      const duplicate = await exceptionsRef()
        .where('attendanceId', '==', attendanceId)
        .where('status', '==', 'pending')
        .limit(1)
        .get();
      if (!duplicate.empty) {
        throw failed(
          'You already have a request waiting for review on that record.',
        );
      }
    }

    const ref = exceptionsRef().doc();
    await ref.set({
      exceptionId: ref.id,
      uid: caller.uid,
      employeeId: caller.employee.employeeId,
      attendanceId,
      type,
      reason,
      status: 'pending' as const,
      submittedAt: FieldValue.serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null,
      reviewNotes: null,
    });

    await writeAudit({
      action: 'exception.submitted',
      actorUid: caller.uid,
      actorEmail: caller.email,
      targetId: ref.id,
      metadata: { type, attendanceId },
    });

    return { exceptionId: ref.id, status: 'pending' as const };
  },
);

/** The caller's own requests, newest first. */
export const listMyExceptions = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireActiveEmployee(request);
    const limit = Math.min(Number(request.data?.limit) || 30, 100);

    const snapshot = await exceptionsRef()
      .where('uid', '==', caller.uid)
      .orderBy('submittedAt', 'desc')
      .limit(limit)
      .get();

    return { exceptions: snapshot.docs.map((d) => summarise(d.data() as ExceptionDoc)) };
  },
);

/** The review queue. Supervisors and admins. */
export const listPendingExceptions = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    await requireRole(request, 'admin', 'supervisor');
    const limit = Math.min(Number(request.data?.limit) || 50, 200);

    const snapshot = await exceptionsRef()
      .where('status', '==', 'pending')
      .orderBy('submittedAt', 'desc')
      .limit(limit)
      .get();

    return { exceptions: snapshot.docs.map((d) => summarise(d.data() as ExceptionDoc)) };
  },
);

/**
 * Approves or rejects a request.
 *
 * Approving does not silently rewrite the attendance record — the flags stay
 * exactly as recorded. The approval sits alongside them as the explanation,
 * which is what an audit needs: not a clean record, but a record plus the
 * reason it looked odd and who accepted it.
 */
export const reviewException = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireRole(request, 'admin', 'supervisor');
    const exceptionId = requireString(request.data?.exceptionId, 'Request', {
      max: 64,
    });
    const decision = request.data?.decision;
    const notes = optionalString(request.data?.notes, 1000);

    if (decision !== 'approved' && decision !== 'rejected') {
      throw badRequest('Decision must be either approved or rejected.');
    }

    const ref = exceptionsRef().doc(exceptionId);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw notFound('That request no longer exists.');
    }
    const exception = snapshot.data() as ExceptionDoc;

    if (exception.status !== 'pending') {
      throw failed('That request has already been reviewed.');
    }
    // Reviewing your own request would defeat the point of the workflow.
    if (exception.uid === caller.uid) {
      throw badRequest('You cannot review your own request.');
    }

    await ref.update({
      status: decision,
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: caller.uid,
      reviewNotes: notes,
    });

    await writeAudit({
      action: `exception.${decision}`,
      actorUid: caller.uid,
      actorEmail: caller.email,
      targetId: exceptionId,
      metadata: { attendanceId: exception.attendanceId, notes },
    });

    return { exceptionId, status: decision };
  },
);

function summarise(e: ExceptionDoc) {
  return {
    exceptionId: e.exceptionId,
    employeeId: e.employeeId,
    attendanceId: e.attendanceId,
    type: e.type,
    reason: e.reason,
    status: e.status,
    submittedAt: e.submittedAt?.toDate().toISOString() ?? null,
    reviewedAt: e.reviewedAt?.toDate().toISOString() ?? null,
    reviewNotes: e.reviewNotes,
  };
}
