/**
 * Device binding — the server half of biometric sign-in.
 *
 * See the note at the top of `lib/crypto.ts` for why this exists and what it
 * does and does not prove. In short: the phone holds a random secret behind
 * the OS biometric gate, we hold only its SHA-256, and presenting the secret
 * is evidence that the enrolled device released it after a successful face
 * or fingerprint check.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { onCall } from 'firebase-functions/v2/https';

import { Config } from '../config';
import { writeAudit } from '../lib/audit';
import {
  failed,
  forbidden,
  notFound,
  optionalString,
  requireString,
} from '../lib/errors';
import {
  hashPin,
  hashSecret,
  hashesMatch,
  requireDeviceSecret,
  requirePin,
} from '../lib/crypto';
import { auth, devicesRef, employeeRef, employeesRef } from '../lib/firebase';
import { requireAuth } from '../lib/guards';
import type { DeviceDoc, EmployeeDoc } from '../types';

/**
 * Binds this device to the signed-in employee.
 *
 * Called once, from sign-up or Settings, after the user picks Face ID /
 * fingerprint (and passes the OS prompt) or chooses a PIN.
 *
 * Pending accounts may enrol, so sign-up can set up quick sign-in in one
 * pass. That grants nothing early: `signInWithDevice` mints a token for a
 * pending employee exactly as a password sign-in would, and every callable
 * that does anything still demands an active account. Suspended and
 * rejected accounts are refused.
 */
export const enrollDevice = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireEnrollableEmployee(request);
    const data = request.data ?? {};

    const deviceId = requireString(data.deviceId, 'Device', { max: 128 });
    const secret = requireDeviceSecret(data.secret);
    const platform = optionalString(data.platform, 32) ?? 'unknown';
    const model = optionalString(data.model, 120) ?? 'Unknown device';
    const method = data.method === 'pin' ? 'pin' : 'biometric';
    const biometricType =
      method === 'pin'
        ? 'pin'
        : (optionalString(data.biometricType, 32) ?? 'unknown');
    // Hashed with the secret as the key, so the stored value is useless
    // without the phone. The PIN itself is never stored or logged.
    const pinHash = method === 'pin' ? hashPin(secret, requirePin(data.pin)) : null;

    const collection = devicesRef(caller.uid);
    const existing = await collection.get();
    const live = existing.docs.filter(
      (doc) => (doc.data() as DeviceDoc).revokedAt === null,
    );

    // Re-enrolling the same device (app reinstalled, secret regenerated) just
    // replaces its secret rather than consuming another slot.
    const isReEnroll = live.some((doc) => doc.id === deviceId);
    if (!isReEnroll && live.length >= Config.device.maxPerEmployee) {
      throw failed(
        `You can use biometric sign-in on up to ${Config.device.maxPerEmployee} devices. Remove one in Settings to add this device.`,
      );
    }

    await collection.doc(deviceId).set(
      {
        deviceId,
        uid: caller.uid,
        secretHash: hashSecret(secret),
        platform,
        model,
        biometricType,
        method,
        pinHash,
        enrolledAt: FieldValue.serverTimestamp(),
        lastUsedAt: null,
        revokedAt: null,
        failedAttempts: 0,
      },
      { merge: false },
    );

    await writeAudit({
      action: isReEnroll ? 'device.reenrolled' : 'device.enrolled',
      actorUid: caller.uid,
      actorEmail: caller.email,
      targetId: deviceId,
      metadata: { platform, model, biometricType, method },
    });

    return {
      deviceId,
      enrolled: true,
      method,
      devicesRemaining: Config.device.maxPerEmployee - (isReEnroll ? live.length : live.length + 1),
    };
  },
);

/**
 * Exchanges a device secret (plus the PIN, on a PIN device) for a Firebase
 * custom token.
 *
 * This is the one unauthenticated entry point in the codebase — by
 * definition, the caller has no session yet. Everything therefore hangs on
 * the secret comparison, so note what is *not* accepted as identification:
 * the request names the employee only by staff number, and that alone gets
 * you nothing. Without the matching 32-byte secret there is no token.
 *
 * Failed attempts are counted against the device and lock it at five,
 * forcing a password sign-in and a fresh enrolment.
 */
export const signInWithDevice = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const data = request.data ?? {};
    const employeeId = requireString(data.employeeId, 'Employee ID', {
      max: 32,
    }).toUpperCase();
    const deviceId = requireString(data.deviceId, 'Device', { max: 128 });
    const secret = requireDeviceSecret(data.secret);
    const pin = typeof data.pin === 'string' ? data.pin : null;

    // A deliberately vague message: which of the three inputs was wrong is
    // not something an attacker should be able to learn by probing.
    const rejection = forbidden(
      'Biometric sign-in could not be verified on this device. Please sign in with your password.',
    );

    const employees = await employeesRef()
      .where('employeeId', '==', employeeId)
      .limit(1)
      .get();
    if (employees.empty) throw rejection;

    const employee = employees.docs[0].data() as EmployeeDoc;
    // Pending accounts get in, like a password sign-in, and land on the
    // "awaiting approval" screen; everything else still demands `active`.
    if (employee.status !== 'active' && employee.status !== 'pending') {
      throw failed(
        'Your account is not active. Please sign in with your password for details.',
      );
    }

    const deviceRef = devicesRef(employee.uid).doc(deviceId);
    const deviceSnapshot = await deviceRef.get();
    if (!deviceSnapshot.exists) throw rejection;

    const device = deviceSnapshot.data() as DeviceDoc;
    if (device.revokedAt !== null) throw rejection;

    if (device.failedAttempts >= Config.device.maxFailedAttempts) {
      throw failed(
        'Quick sign-in is locked on this device. Sign in with your password to set it up again.',
      );
    }

    const method = device.method ?? 'biometric';
    const pinOk =
      method !== 'pin' ||
      (pin !== null &&
        typeof device.pinHash === 'string' &&
        hashesMatch(device.pinHash, hashPin(secret, pin)));

    const secretOk = hashesMatch(device.secretHash, hashSecret(secret));
    if (!secretOk || !pinOk) {
      const attempts = device.failedAttempts + 1;
      await deviceRef.update({ failedAttempts: FieldValue.increment(1) });
      await writeAudit({
        action: 'device.signin_failed',
        actorUid: employee.uid,
        targetId: deviceId,
        metadata: { employeeId, attempts, method },
      });
      // Only once the secret has proved this is the enrolled phone is it
      // safe to say the PIN was the problem — and useful, since the holder
      // needs to know how many tries remain before the lockout.
      if (secretOk) {
        const left = Config.device.maxFailedAttempts - attempts;
        throw forbidden(
          left > 0
            ? `Incorrect PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`
            : 'Incorrect PIN. PIN sign-in is now locked on this phone — sign in with your password to set it up again.',
        );
      }
      throw rejection;
    }

    await deviceRef.update({
      lastUsedAt: FieldValue.serverTimestamp(),
      failedAttempts: 0,
    });

    // `biometric: true` rides along in the token so `clockIn` can record
    // that this shift was started from a biometrically verified session.
    const token = await auth.createCustomToken(employee.uid, {
      biometric: method === 'biometric',
      pin: method === 'pin',
      deviceId,
    });

    await writeAudit({
      action: 'device.signin',
      actorUid: employee.uid,
      targetId: deviceId,
      metadata: { employeeId, method },
    });

    return {
      token,
      method,
      status: employee.status,
      uid: employee.uid,
      employeeId: employee.employeeId,
      fullName: employee.fullName,
      role: employee.role,
    };
  },
);

/** Lists the caller's bound devices so they can manage them in Settings. */
export const listDevices = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const { uid } = requireAuth(request);
    const snapshot = await devicesRef(uid).orderBy('enrolledAt', 'desc').get();

    return {
      devices: snapshot.docs
        .map((doc) => doc.data() as DeviceDoc)
        .filter((d) => d.revokedAt === null)
        .map((d) => ({
          deviceId: d.deviceId,
          platform: d.platform,
          model: d.model,
          biometricType: d.biometricType,
          method: d.method ?? 'biometric',
          enrolledAt: d.enrolledAt?.toDate().toISOString() ?? null,
          lastUsedAt: d.lastUsedAt?.toDate().toISOString() ?? null,
          locked: d.failedAttempts >= Config.device.maxFailedAttempts,
        })),
    };
  },
);

/**
 * Revokes a device — "I lost my phone".
 *
 * The employee can revoke their own; an admin can revoke anyone's. Revoking
 * is a soft delete so the audit trail keeps showing that the device once
 * existed and what it was used for.
 */
export const revokeDevice = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const { uid, email } = requireAuth(request);
    const deviceId = requireString(request.data?.deviceId, 'Device', {
      max: 128,
    });
    const targetUid = optionalString(request.data?.uid, 128) ?? uid;

    if (targetUid !== uid) {
      const callerDoc = await employeeRef(uid).get();
      const caller = callerDoc.data() as EmployeeDoc | undefined;
      if (caller?.role !== 'admin') {
        throw forbidden('You can only remove your own devices.');
      }
    }

    const ref = devicesRef(targetUid).doc(deviceId);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw notFound('That device is not registered.');
    }

    await ref.update({
      revokedAt: FieldValue.serverTimestamp(),
      // Clearing the hash guarantees the secret is useless even if the
      // document is later restored from a backup.
      secretHash: '',
    });

    await writeAudit({
      action: 'device.revoked',
      actorUid: uid,
      actorEmail: email,
      targetId: deviceId,
      metadata: { targetUid, selfService: targetUid === uid },
    });

    return { deviceId, revoked: true };
  },
);

/**
 * Returns the caller's profile and biometric state.
 *
 * The app calls this on launch to decide what to show: the pending-approval
 * screen, the "turn on Face ID" prompt, or straight through to the home
 * screen.
 */
export const getMyProfile = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const { uid } = requireAuth(request);
    const snapshot = await employeeRef(uid).get();
    if (!snapshot.exists) {
      throw notFound('We could not find your employee record.');
    }
    const employee = snapshot.data() as EmployeeDoc;

    const devices = await devicesRef(uid).get();
    const activeDevices = devices.docs
      .map((d) => d.data() as DeviceDoc)
      .filter((d) => d.revokedAt === null);

    return {
      uid: employee.uid,
      employeeId: employee.employeeId,
      fullName: employee.fullName,
      email: employee.email,
      role: employee.role,
      status: employee.status,
      statusReason: employee.statusReason,
      siteId: employee.siteId,
      department: employee.department,
      biometricEnrolled: activeDevices.length > 0,
      deviceCount: activeDevices.length,
    };
  },
);

/**
 * Signed in, with an employee record that is active or still pending.
 *
 * Deliberately narrower than "any signed-in user": a suspended or rejected
 * account must not be able to bind a new phone.
 */
async function requireEnrollableEmployee(
  request: Parameters<typeof requireAuth>[0],
): Promise<{ uid: string; email: string | null; employee: EmployeeDoc }> {
  const { uid, email } = requireAuth(request);
  const snapshot = await employeeRef(uid).get();
  if (!snapshot.exists) {
    throw notFound('We could not find your employee record.');
  }
  const employee = snapshot.data() as EmployeeDoc;
  if (employee.status !== 'active' && employee.status !== 'pending') {
    throw forbidden(
      employee.statusReason ?? 'Your account is not active. Please contact HR.',
    );
  }
  return { uid, email, employee };
}
