/**
 * Sign-up: creating the employee record behind a new Firebase Auth user.
 *
 * The account is created by the app with Firebase Auth's own
 * `createUserWithEmailAndPassword`, so we never handle the password. What
 * this module adds is the part Auth does not model: an employee profile that
 * starts `pending` and cannot do anything until an admin approves it.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { onCall } from 'firebase-functions/v2/https';
import { beforeUserCreated } from 'firebase-functions/v2/identity';

import { Config } from '../config';
import { writeAudit } from '../lib/audit';
import {
  badRequest,
  conflict,
  optionalString,
  requireString,
} from '../lib/errors';
import { auth, db, employeeRef, employeesRef } from '../lib/firebase';
import { normalisePhone, optionalPhone } from '../lib/phone';
import { requireAuth } from '../lib/guards';
import { setEmployeeClaims } from './claims';
import type { EmployeeDoc } from '../types';

/**
 * Blocks sign-ups from outside the allowed email domains.
 *
 * Runs inside Firebase Auth before the user row is created, so a rejected
 * address leaves nothing behind to clean up. With
 * `Config.signUp.allowedEmailDomains` empty this is a no-op — set it to
 * `['mangaung.gov.za']` to restrict registration to staff addresses.
 */
export const enforceSignUpDomain = beforeUserCreated((event) => {
  const allowed = Config.signUp.allowedEmailDomains as readonly string[];
  if (allowed.length === 0) return;

  const email = event.data?.email?.toLowerCase() ?? '';
  const domain = email.split('@')[1] ?? '';
  if (!allowed.includes(domain)) {
    throw badRequest(
      `Sign-up is limited to ${allowed.join(', ')} email addresses.`,
    );
  }
  return;
});

/**
 * Creates the pending employee profile for the freshly created auth user.
 *
 * Called by the app straight after `createUserWithEmailAndPassword`, while
 * signed in as the new user. It is idempotent — a retry after a dropped
 * connection returns the existing profile rather than erroring — because the
 * app's most likely failure is exactly that: account created, profile call
 * lost, user left in limbo with an email address they can no longer reuse.
 */
export const createEmployeeProfile = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const { uid, email } = requireAuth(request);
    const data = request.data ?? {};

    const existing = await employeeRef(uid).get();
    if (existing.exists) {
      const employee = existing.data() as EmployeeDoc;
      return {
        created: false,
        status: employee.status,
        employeeId: employee.employeeId,
        fullName: employee.fullName,
      };
    }

    const fullName = requireString(data.fullName, 'Full name', {
      min: 2,
      max: 120,
    });
    const requestedId = optionalString(data.employeeId, 32);
    const phone = optionalPhone(data.phone);
    const department = optionalString(data.department, 120);
    const siteId = optionalString(data.siteId, 64);

    const contactEmail =
      email ?? requireString(data.email, 'Email address', { max: 254 });

    // The staff number is the link to payroll, so it must be unique. When the
    // user supplies one we hold them to it; otherwise we allocate the next
    // free EMP-xxxx.
    const employeeId = requestedId
      ? await claimEmployeeId(requestedId)
      : await allocateEmployeeId();

    const now = FieldValue.serverTimestamp();
    const profile = {
      uid,
      employeeId,
      fullName,
      email: contactEmail.toLowerCase(),
      phone,
      role: 'employee' as const,
      status: 'pending' as const,
      siteId,
      department,
      createdAt: now,
      updatedAt: now,
      reviewedAt: null,
      reviewedBy: null,
      statusReason: null,
    };

    await employeeRef(uid).set(profile);

    // Stamp the claims now so firestore.rules sees `status: pending` rather
    // than an absent claim, which would be indistinguishable from a
    // half-created account.
    await setEmployeeClaims(uid, {
      role: 'employee',
      status: 'pending',
      employeeId,
    });

    await writeAudit({
      action: 'employee.signup',
      actorUid: uid,
      actorEmail: contactEmail,
      targetId: uid,
      metadata: { employeeId, fullName, department },
    });

    return {
      created: true,
      status: 'pending' as const,
      employeeId,
      fullName,
    };
  },
);

/**
 * Reserves a user-supplied staff number, refusing one already in use.
 *
 * Firestore has no unique constraint, so uniqueness is enforced by a
 * transaction over the query. Two simultaneous sign-ups claiming the same id
 * will have one of them retried by Firestore and then fail cleanly here.
 */
async function claimEmployeeId(requested: string): Promise<string> {
  const employeeId = requested.toUpperCase();
  if (!/^[A-Z0-9-]{3,32}$/.test(employeeId)) {
    throw badRequest(
      'Employee ID may only contain letters, numbers and dashes.',
    );
  }

  return db.runTransaction(async (tx) => {
    const clash = await tx.get(
      employeesRef().where('employeeId', '==', employeeId).limit(1),
    );
    if (!clash.empty) {
      throw conflict(
        'That employee ID is already registered. Please check the number or contact HR.',
      );
    }
    return employeeId;
  });
}

/** Allocates the next `EMP-xxxx` by looking at the highest one issued. */
async function allocateEmployeeId(): Promise<string> {
  const latest = await employeesRef()
    .orderBy('employeeId', 'desc')
    .limit(1)
    .get();

  let next = 1;
  if (!latest.empty) {
    const current = (latest.docs[0].data() as EmployeeDoc).employeeId ?? '';
    const digits = current.match(/(\d+)\s*$/)?.[1];
    if (digits) next = Number.parseInt(digits, 10) + 1;
  }
  return `EMP-${String(next).padStart(4, '0')}`;
}

/**
 * Deletes the auth user when profile creation is abandoned.
 *
 * Exposed so the app can call it if the user backs out of a half-finished
 * sign-up; without it the email address would be permanently unusable.
 */
export const cancelSignUp = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const { uid } = requireAuth(request);
    const snapshot = await employeeRef(uid).get();

    // Only ever removes a profile that is still pending — this must not
    // become a way for an active employee to erase their own history.
    if (snapshot.exists) {
      const employee = snapshot.data() as EmployeeDoc;
      if (employee.status !== 'pending') {
        throw badRequest('Your account is already active and cannot be removed here.');
      }
      await employeeRef(uid).delete();
    }

    await auth.deleteUser(uid);
    return { deleted: true };
  },
);

/**
 * Lets an employee update their own contact number.
 *
 * Only the phone: name, staff number, department and site are HR's to change
 * (via the admin dashboard), because payroll keys off them. Works for any
 * signed-in employee with a profile, pending or active, so someone can fix a
 * typo while they wait for approval.
 */
export const updateMyProfile = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const { uid, email } = requireAuth(request);
    const ref = employeeRef(uid);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw badRequest('We could not find your employee record.');
    }

    const phone = normalisePhone(request.data?.phone);
    const previous = (snapshot.data() as EmployeeDoc).phone ?? null;

    await ref.update({ phone, updatedAt: FieldValue.serverTimestamp() });

    await writeAudit({
      action: 'employee.phone_updated',
      actorUid: uid,
      actorEmail: email,
      targetId: uid,
      metadata: { hadPhone: previous !== null },
    });

    return { phone };
  },
);
