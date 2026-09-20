/**
 * Credential and environment setup for running the callables outside Cloud
 * Functions.
 *
 * This module must be imported *before* anything that touches the Admin SDK:
 * `lib/firebase.ts` calls `initializeApp()` at module load, and that reads
 * Application Default Credentials there and then. TypeScript emits CommonJS
 * requires in source order, so a bare `import './bootstrap'` at the top of an
 * entrypoint is enough to guarantee it.
 *
 * Cloud Functions injects credentials and the project id automatically. A
 * generic host does not, so both come from the environment:
 *
 *   FIREBASE_SERVICE_ACCOUNT_BASE64  base64 of the service account JSON
 *   GCLOUD_PROJECT                   project id (defaults from the key)
 *
 * The key arrives base64-encoded because it is multi-line JSON, and most
 * dashboards mangle newlines in environment variables.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

if (encoded && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  let parsed: { project_id?: string };
  const json = Buffer.from(encoded, 'base64').toString('utf8');

  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_BASE64 is not valid base64-encoded JSON. ' +
        'Re-encode the key file with: base64 -i serviceAccountKey.json',
    );
  }

  // The Admin SDK reads credentials from a file path, so the decoded key has
  // to land on disk. A private temp directory keeps it out of the deployment
  // bundle and away from anything that might serve static files.
  const path = join(mkdtempSync(join(tmpdir(), 'motiroong-')), 'sa.json');
  writeFileSync(path, json, { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path;

  if (!process.env.GCLOUD_PROJECT && parsed.project_id) {
    process.env.GCLOUD_PROJECT = parsed.project_id;
  }
}

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    'No credentials. Set FIREBASE_SERVICE_ACCOUNT_BASE64 (or ' +
      'GOOGLE_APPLICATION_CREDENTIALS) so the Admin SDK can reach the ' +
      'project, or point at the emulators with FIRESTORE_EMULATOR_HOST.',
  );
}
