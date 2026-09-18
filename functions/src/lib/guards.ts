/**
 * Caller checks shared by the callable handlers.
 */
import type { CallableRequest } from 'firebase-functions/v2/https';
import { employeeRef } from './firebase';
import { failed, forbidden, notFound, unauthenticated } from './errors';
import type { EmployeeDoc, EmployeeRole } from '../types';

export interface Caller {
  uid: string;
  email: string | null;
  role: EmployeeRole;
  employee: EmployeeDoc;
}

/** Requires a signed-in caller and returns their uid. */
export function requireAuth(request: CallableRequest): {
  uid: string;
  email: string | null;
} {
  const auth = request.auth;
  if (!auth?.uid) {
    throw unauthenticated();
  }
  return { uid: auth.uid, email: auth.token?.email ?? null };
}

/**
 * Requires a caller whose employee record is `active`.
 *
 * The status is re-read from Firestore rather than trusted from the token,
 * because custom claims live in an ID token that stays valid for up to an
 * hour after a suspension. For clocking in that lag is acceptable; for
 * anything that changes another person's record it is not.
 */
export async function requireActiveEmployee(
  request: CallableRequest,
): Promise<Caller> {
  const { uid, email } = requireAuth(request);
  const snapshot = await employeeRef(uid).get();

  if (!snapshot.exists) {
    throw notFound('We could not find your employee record.');
  }
  const employee = snapshot.data() as EmployeeDoc;

  switch (employee.status) {
    case 'active':
      break;
    case 'pending':
      throw failed(
        'Your account is still waiting for approval. You will be notified once an administrator has reviewed it.',
      );
    case 'suspended':
      throw forbidden(
        employee.statusReason ??
          'Your account has been suspended. Please contact your supervisor.',
      );
    case 'rejected':
      throw forbidden(
        employee.statusReason ??
          'Your sign-up request was not approved. Please contact HR.',
      );
    default:
      throw forbidden('Your account is not active.');
  }

  return { uid, email, role: employee.role, employee };
}

/** Requires an active caller holding one of [roles]. */
export async function requireRole(
  request: CallableRequest,
  ...roles: EmployeeRole[]
): Promise<Caller> {
  const caller = await requireActiveEmployee(request);
  if (!roles.includes(caller.role)) {
    throw forbidden('You do not have permission to do that.');
  }
  return caller;
}
