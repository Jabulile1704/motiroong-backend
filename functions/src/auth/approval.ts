/**
 * The admin side of sign-up: approve, reject, suspend, reinstate.
 *
 * This is the gate that makes self-registration safe. Anyone can create an
 * account, but until someone with the `admin` role approves it the employee
 * cannot read a site, cannot clock in, and cannot bind a device.
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
import { employeeRef, employeesRef } from '../lib/firebase';
import { requireRole } from '../lib/guards';
import { setClaimsAndRevoke, setEmployeeClaims } from './claims';
import type { EmployeeDoc, EmployeeRole } from '../types';

/** Lists sign-ups awaiting review, newest first. */
export const listPendingEmployees = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    await requireRole(request, 'admin', 'supervisor');

    const limit = Math.min(Number(request.data?.limit) || 50, 200);
    const snapshot = await employeesRef()
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    return {
      employees: snapshot.docs.map((doc) => {
        const e = doc.data() as EmployeeDoc;
        return {
          uid: e.uid,
          employeeId: e.employeeId,
          fullName: e.fullName,
          email: e.email,
          phone: e.phone,
          department: e.department,
          siteId: e.siteId,
          createdAt: e.createdAt?.toDate().toISOString() ?? null,
        };
      }),
    };
  },
);

/**
 * Approves a pending sign-up.
 *
 * The admin may correct the staff number, assign a home site and set a role
 * at the same time — in practice they are checking the request against an HR
 * list, and the details the employee typed are often close but not exact.
 */
export const approveEmployee = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireRole(request, 'admin');
    const uid = requireString(request.data?.uid, 'Employee');

    const role = parseRole(request.data?.role) ?? 'employee';
    const siteId = optionalString(request.data?.siteId, 64);
    const employeeIdOverride = optionalString(request.data?.employeeId, 32);

    const ref = employeeRef(uid);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw notFound('That employee record no longer exists.');
    }

    const employee = snapshot.data() as EmployeeDoc;
    if (employee.status === 'active') {
      throw failed('That employee is already active.');
    }

    const employeeId = employeeIdOverride
      ? employeeIdOverride.toUpperCase()
      : employee.employeeId;

    await ref.update({
      status: 'active',
      role,
      employeeId,
      siteId: siteId ?? employee.siteId,
      statusReason: null,
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: caller.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });

    await setEmployeeClaims(uid, { role, status: 'active', employeeId });

    await writeAudit({
      action: 'employee.approved',
      actorUid: caller.uid,
      actorEmail: caller.email,
      targetId: uid,
      metadata: { employeeId, role, siteId: siteId ?? employee.siteId },
    });

    return { uid, status: 'active' as const, role, employeeId };
  },
);

/** Turns down a pending sign-up, with a reason the employee will see. */
export const rejectEmployee = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireRole(request, 'admin');
    const uid = requireString(request.data?.uid, 'Employee');
    const reason = requireString(request.data?.reason, 'Reason', { max: 500 });

    const ref = employeeRef(uid);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw notFound('That employee record no longer exists.');
    }
    const employee = snapshot.data() as EmployeeDoc;

    await ref.update({
      status: 'rejected',
      statusReason: reason,
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: caller.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });

    await setClaimsAndRevoke(uid, {
      role: employee.role,
      status: 'rejected',
      employeeId: employee.employeeId,
    });

    await writeAudit({
      action: 'employee.rejected',
      actorUid: caller.uid,
      actorEmail: caller.email,
      targetId: uid,
      metadata: { reason },
    });

    return { uid, status: 'rejected' as const };
  },
);

/**
 * Suspends an active employee.
 *
 * Revokes their refresh tokens, so the app is signed out on its next call
 * rather than up to an hour later. Enrolled devices are left in place —
 * a suspension is usually temporary, and making someone re-enrol their
 * fingerprint afterwards is friction with no security benefit.
 */
export const setEmployeeStatus = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireRole(request, 'admin');
    const uid = requireString(request.data?.uid, 'Employee');
    const status = request.data?.status;
    const reason = optionalString(request.data?.reason, 500);

    if (status !== 'active' && status !== 'suspended') {
      throw badRequest('Status must be either active or suspended.');
    }
    if (uid === caller.uid) {
      throw badRequest('You cannot change your own account status.');
    }

    const ref = employeeRef(uid);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw notFound('That employee record no longer exists.');
    }
    const employee = snapshot.data() as EmployeeDoc;

    await ref.update({
      status,
      statusReason: status === 'suspended' ? reason : null,
      updatedAt: FieldValue.serverTimestamp(),
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: caller.uid,
    });

    const claims = {
      role: employee.role,
      status,
      employeeId: employee.employeeId,
    };
    if (status === 'suspended') {
      await setClaimsAndRevoke(uid, claims);
    } else {
      await setEmployeeClaims(uid, claims);
    }

    await writeAudit({
      action: `employee.${status}`,
      actorUid: caller.uid,
      actorEmail: caller.email,
      targetId: uid,
      metadata: { reason },
    });

    return { uid, status };
  },
);

/** Changes an employee's role. Admins only, and never your own. */
export const setEmployeeRole = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireRole(request, 'admin');
    const uid = requireString(request.data?.uid, 'Employee');
    const role = parseRole(request.data?.role);

    if (!role) {
      throw badRequest('Role must be employee, supervisor or admin.');
    }
    // Stops an admin from demoting themselves and locking the last admin out.
    if (uid === caller.uid) {
      throw badRequest('You cannot change your own role.');
    }

    const ref = employeeRef(uid);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw notFound('That employee record no longer exists.');
    }
    const employee = snapshot.data() as EmployeeDoc;

    await ref.update({ role, updatedAt: FieldValue.serverTimestamp() });
    await setEmployeeClaims(uid, {
      role,
      status: employee.status,
      employeeId: employee.employeeId,
    });

    await writeAudit({
      action: 'employee.role_changed',
      actorUid: caller.uid,
      actorEmail: caller.email,
      targetId: uid,
      metadata: { from: employee.role, to: role },
    });

    return { uid, role };
  },
);

function parseRole(value: unknown): EmployeeRole | null {
  if (value === 'employee' || value === 'supervisor' || value === 'admin') {
    return value;
  }
  return null;
}
