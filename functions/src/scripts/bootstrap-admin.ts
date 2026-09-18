/**
 * Creates the first administrator.
 *
 * Chicken-and-egg problem: `approveEmployee` requires an admin, and the only
 * way to become an admin is to be approved by one. This script breaks the
 * cycle, and is meant to be run once against a fresh project from a trusted
 * machine — not deployed.
 *
 *   cd functions
 *   npm run build
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json \
 *     node lib/scripts/bootstrap-admin.js admin@mangaung.gov.za 'Full Name'
 *
 * If the email already has an account, it is promoted in place; otherwise a
 * new one is created and a password-reset link is printed for the admin to
 * set their own password — so no password is ever typed into a terminal or
 * left in shell history.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { auth, employeeRef } from '../lib/firebase';
import { setEmployeeClaims } from '../auth/claims';

async function main() {
  const [email, fullName] = process.argv.slice(2);

  if (!email || !fullName) {
    console.error(
      'Usage: node lib/scripts/bootstrap-admin.js <email> "<full name>"',
    );
    process.exit(1);
  }

  let uid: string;
  let created = false;

  try {
    const existing = await auth.getUserByEmail(email);
    uid = existing.uid;
    console.log(`Found existing auth user ${uid} — promoting to admin.`);
  } catch {
    const user = await auth.createUser({ email, displayName: fullName });
    uid = user.uid;
    created = true;
    console.log(`Created auth user ${uid}.`);
  }

  const employeeId = 'ADM-0001';
  const now = FieldValue.serverTimestamp();

  await employeeRef(uid).set(
    {
      uid,
      employeeId,
      fullName,
      email: email.toLowerCase(),
      phone: null,
      role: 'admin',
      status: 'active',
      siteId: null,
      department: 'Administration',
      createdAt: now,
      updatedAt: now,
      reviewedAt: now,
      reviewedBy: 'bootstrap',
      statusReason: null,
    },
    { merge: true },
  );

  await setEmployeeClaims(uid, {
    role: 'admin',
    status: 'active',
    employeeId,
  });

  console.log(`\n${fullName} <${email}> is now an active admin (${employeeId}).`);

  if (created) {
    const link = await auth.generatePasswordResetLink(email);
    console.log('\nSet the password using this single-use link:\n');
    console.log(link);
  }

  console.log('\nSign out and back in on any device to pick up the new claims.');
}

main().catch((error) => {
  console.error('bootstrap-admin failed:', error);
  process.exit(1);
});
