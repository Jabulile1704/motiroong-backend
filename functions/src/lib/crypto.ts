/**
 * Device-secret hashing for biometric sign-in.
 *
 * How the biometric flow actually works, since "biometric login" is a
 * misleading name:
 *
 *   1. The phone generates 32 random bytes — the *device secret* — and puts
 *      it in the Keychain / Android Keystore behind a biometric gate.
 *   2. It sends us only SHA-256 of that secret (see `enrollDevice`).
 *   3. To sign in later, the OS checks the user's face or fingerprint. That
 *      check happens entirely on the phone; we never see it and cannot
 *      verify it. What a successful check does is *release the secret* from
 *      the Keychain.
 *   4. The app presents the secret; we hash it and compare. A match means
 *      the request came from an enrolled device whose owner just passed the
 *      OS biometric prompt, so we mint a Firebase custom token.
 *
 * So the biometric never leaves the device and is never transmitted — the
 * README's claim is literally true. The security property we get is
 * possession of an enrolled device plus a local user-presence check, which
 * is the same guarantee as a passkey and strictly better than a stored
 * password.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Config } from '../config';
import { badRequest } from './errors';

/** SHA-256 hex digest. The secret is high-entropy, so no KDF is needed. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `===` on a hash leaks how many leading characters matched via timing.
 * That is a thin channel, but the fix is one line, so there is no reason to
 * leave it open.
 */
export function hashesMatch(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** Validates the secret the client presents: 64 lowercase hex characters. */
export function requireDeviceSecret(value: unknown): string {
  if (typeof value !== 'string') {
    throw badRequest('This device is not set up for biometric sign-in.');
  }
  const secret = value.trim().toLowerCase();
  const expected = Config.device.secretHexLength;
  if (secret.length !== expected || !/^[0-9a-f]+$/.test(secret)) {
    throw badRequest('This device is not set up for biometric sign-in.');
  }
  return secret;
}

/**
 * Hash of a sign-in PIN, keyed with the device secret.
 *
 * A 6-digit PIN has only a million values, so a plain or even a slow hash of
 * it could be brute-forced by anyone holding a copy of the database. Keying
 * the HMAC with the device secret closes that: we store only SHA-256 of the
 * secret, never the secret, so a leaked `pinHash` cannot be tested offline
 * without 256 bits the server does not keep. Online guessing is capped by the
 * device's `failedAttempts` lockout instead.
 */
export function hashPin(secret: string, pin: string): string {
  return createHmac('sha256', secret).update(`pin:${pin}`, 'utf8').digest('hex');
}

/**
 * Validates a sign-in PIN: exactly six digits, and not one of the handful
 * everyone tries first (a single repeated digit, or a straight run).
 */
export function requirePin(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value)) {
    throw badRequest('Your PIN must be exactly 6 digits.');
  }
  if (isTrivialPin(value)) {
    throw badRequest('That PIN is too easy to guess. Please choose another.');
  }
  return value;
}

/** Repeated digits (111111) or a straight run up or down (123456, 987654). */
export function isTrivialPin(pin: string): boolean {
  const digits = [...pin].map(Number);
  if (digits.every((d) => d === digits[0])) return true;
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

/** Generates a device id. Used by the seed script and tests. */
export function newDeviceId(): string {
  return randomBytes(16).toString('hex');
}
