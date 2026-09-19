/**
 * Phone numbers, as employees type them.
 *
 * Deliberately forgiving on format — "082 555 1234", "+27 82-555-1234" and
 * "0825551234" are all the same number to a supervisor who needs to call —
 * but strict on content: digits, spaces, dashes, brackets and one leading
 * plus, with 9 to 15 digits (the E.164 ceiling). The stored value is
 * normalised to single spaces so it reads the same everywhere it is shown.
 */
import { badRequest } from './errors';

export function normalisePhone(value: unknown): string {
  if (typeof value !== 'string') {
    throw badRequest('Please enter your phone number.');
  }
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!/^\+?[\d\s()-]+$/.test(trimmed)) {
    throw badRequest(
      'A phone number may contain only digits, spaces, dashes and a leading +.',
    );
  }
  const digits = trimmed.replace(/\D/g, '').length;
  if (digits < 9 || digits > 15) {
    throw badRequest('Please enter a full phone number, e.g. 082 555 1234.');
  }
  return trimmed;
}

/** For optional fields: blank or missing is null, anything else must be valid. */
export function optionalPhone(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return normalisePhone(value);
}
