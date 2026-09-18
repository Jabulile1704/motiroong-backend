/**
 * Custom claims — the bridge between an employee document and
 * `firestore.rules`.
 *
 * Rules cannot read another document, so role and status have to travel in
 * the ID token. The catch is that a token stays valid for up to an hour, so
 * a claim change is not immediately effective: `revokeRefreshTokens` forces
 * the app to fetch a fresh one on its next call.
 */
import { auth } from '../lib/firebase';
import type { MotiroongClaims } from '../types';

/** Writes the claims and forces the client to pick them up. */
export async function setEmployeeClaims(
  uid: string,
  claims: MotiroongClaims,
): Promise<void> {
  await auth.setCustomUserClaims(uid, {
    role: claims.role,
    status: claims.status,
    employeeId: claims.employeeId,
  });
}

/**
 * Applies claims and invalidates existing sessions.
 *
 * Use this whenever access is being *reduced* (suspension, rejection, role
 * downgrade). For an upgrade, `setEmployeeClaims` is enough — the app calls
 * `getIdToken(true)` after approval anyway.
 */
export async function setClaimsAndRevoke(
  uid: string,
  claims: MotiroongClaims,
): Promise<void> {
  await setEmployeeClaims(uid, claims);
  await auth.revokeRefreshTokens(uid);
}
