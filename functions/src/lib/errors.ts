/**
 * Error helpers.
 *
 * Callable functions surface `HttpsError.message` straight to the user, so
 * every message here is written to be read by an employee on a phone, not by
 * a developer in a log.
 */
import { HttpsError } from 'firebase-functions/v2/https';

export const badRequest = (message: string) =>
  new HttpsError('invalid-argument', message);

export const unauthenticated = (message = 'Please sign in and try again.') =>
  new HttpsError('unauthenticated', message);

export const forbidden = (message = 'You do not have access to do that.') =>
  new HttpsError('permission-denied', message);

export const notFound = (message: string) =>
  new HttpsError('not-found', message);

export const conflict = (message: string) =>
  new HttpsError('already-exists', message);

export const failed = (message: string) =>
  new HttpsError('failed-precondition', message);

export const rateLimited = (message: string) =>
  new HttpsError('resource-exhausted', message);

export const internal = (message = 'Something went wrong. Please try again.') =>
  new HttpsError('internal', message);

/** Reads a required string field, trimming it and rejecting blanks. */
export function requireString(
  value: unknown,
  field: string,
  { max = 500, min = 1 }: { max?: number; min?: number } = {},
): string {
  if (typeof value !== 'string') {
    throw badRequest(`${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw badRequest(`${field} is required.`);
  }
  if (trimmed.length > max) {
    throw badRequest(`${field} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

/** Reads an optional string, mapping blanks to null. */
export function optionalString(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

/** Reads a finite number within range. */
export function requireNumber(
  value: unknown,
  field: string,
  { min = -Infinity, max = Infinity }: { min?: number; max?: number } = {},
): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw badRequest(`${field} must be a number.`);
  }
  if (n < min || n > max) {
    throw badRequest(`${field} is out of range.`);
  }
  return n;
}
