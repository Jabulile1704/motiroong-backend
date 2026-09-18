# MoTiroong Backend

Firebase backend for the [MoTiroong](https://github.com/Jabulile1704/motiroong-mobile)
staff attendance app — Firestore for data, Firebase Auth for identity, and
Cloud Functions for every decision that must not be made on the phone.

## Architecture

There is no API server. The Flutter app talks to Firebase directly through
the official SDKs, and calls **callable Cloud Functions** for anything
privileged. That removes the bearer-token plumbing entirely: the SDK attaches
and refreshes the ID token itself, so there is no `baseUrl`, no auth
interceptor, and no refresh-token rotation to get wrong.

```
Flutter app
   │
   ├── Firebase Auth ............ email/password sign-up + custom tokens
   │
   ├── Firestore (reads only) ... own profile, own history, site geofences
   │
   └── Cloud Functions (callable)
          ├── auth ......... sign-up, admin approval, device binding
          ├── attendance ... clock in/out, geofence verdict, history
          └── exceptions ... flag appeals and supervisor review
```

### The client never writes

`firestore.rules` grants reads and denies **every** client write. All state
changes go through functions, which use the Admin SDK and bypass rules.

This is the central design decision. An attendance record is only worth
anything if the device that benefits from it cannot author it — if the app
could write to `attendance/` directly, an employee could fabricate a shift
from their couch. So the app asks to clock in; it does not record that it
did.

Two things follow from that:

- **Timestamps are server-side.** `clockInAt` is `serverTimestamp()`. A phone
  with its clock wound back cannot backdate a shift; it only earns itself a
  `clock_skew` flag.
- **The geofence verdict is server-side.** The app shows the user whether
  they look in range as a courtesy. The stored distance and flags are
  recomputed from the site record.

### Flag, don't refuse

Clocking in outside the geofence is **recorded, not rejected**. Refusing
leaves an employee who is legitimately off-site — a callout, a depot visit, a
dead GPS — with no way to record that they worked, and the usual result is a
paper note nobody reconciles. Instead the event is stored with an
`outside_geofence` flag, the employee explains it via `submitException`, and a
supervisor decides. The audit trail keeps the anomaly *and* the reason it was
accepted, which is what an auditor actually needs.

## How biometric sign-in works

"Biometric login" is a misleading name, so here is the actual mechanism.

1. The phone generates 32 random bytes — the **device secret** — and stores it
   in the iOS Keychain / Android Keystore behind a biometric gate.
2. It sends us only `SHA-256(secret)` (`enrollDevice`).
3. To sign in later, the OS checks the user's face or fingerprint. That check
   happens **entirely on the phone**. We never see it and cannot verify it.
   What a successful check does is *release the secret* from the Keychain.
4. The app presents the secret to `signInWithDevice`. We hash it and compare
   in constant time. A match means the request came from an enrolled device
   whose owner just passed the OS prompt, so we mint a Firebase custom token.

The biometric therefore never leaves the device and is never transmitted —
the app's privacy claim is literally true. What the server actually verifies
is *possession of an enrolled device* plus *a local user-presence check*: the
same guarantee as a passkey, and strictly better than a stored password.

The minted token carries `biometric: true`, which is why `clockIn` can record
whether a shift was started from a verified session — and why the app cannot
simply claim it was.

Five failed presentations lock the device and force a password sign-in.

## Sign-up and approval

Self-registration is open, but a new account lands in `pending` and can do
nothing — no clock-in, no site reads, no device binding — until an admin
approves it. Status and role live in **custom claims**, not in the employee
document, so a user cannot escalate themselves by writing to their own
profile.

```
sign up ──▶ pending ──▶ active ──▶ suspended
                │                      │
                └──▶ rejected          └──▶ active
```

Claims lag by up to an hour (an ID token's lifetime), so anything that
*reduces* access also calls `revokeRefreshTokens`, and guards re-read status
from Firestore rather than trusting the token.

## Data model

| Collection | Document | Notes |
|---|---|---|
| `employees/{uid}` | profile, role, status | uid matches Firebase Auth |
| `employees/{uid}/devices/{deviceId}` | `secretHash`, platform, model | biometric bindings; soft-deleted on revoke |
| `sites/{siteId}` | lat/lng + `radiusMeters` | geofences; archived, never deleted |
| `attendance/{recordId}` | clock in/out, distances, `flags[]` | server timestamps only |
| `exceptions/{exceptionId}` | appeal + review decision | |
| `auditLogs/{logId}` | append-only trail | admin-readable, never writable |

Full field definitions with commentary: [`functions/src/types.ts`](functions/src/types.ts).

## Functions

**Auth** — `createEmployeeProfile`, `cancelSignUp`, `enforceSignUpDomain`,
`getMyProfile`
**Approval** — `approveEmployee`, `rejectEmployee`, `setEmployeeStatus`,
`setEmployeeRole`, `listPendingEmployees`
**Devices** — `enrollDevice`, `signInWithDevice`, `listDevices`, `revokeDevice`
**Attendance** — `clockIn`, `clockOut`, `getClockStatus`,
`getAttendanceHistory`, `getAttendanceRecord`
**Sites** — `listSites`, `upsertSite`, `archiveSite`
**Exceptions** — `submitException`, `listMyExceptions`,
`listPendingExceptions`, `reviewException`
**Scheduled** — `closeStaleShiftsNightly` (02:00 SAST)

`signInWithDevice` is the only unauthenticated callable, by necessity — the
caller has no session yet. It identifies the employee by staff number, which
on its own gets you nothing; everything rests on the secret comparison.

## Setup

> On a no-cost (Spark) account, read [`SETUP.md`](SETUP.md) first: Cloud
> Functions are Blaze-only, so the emulator suite — not the console — is where
> this backend runs until you upgrade. `SETUP.md` also covers the
> `africa-south1`/POPIA reasoning, cost caps, and the admin console plan.

### 1. Create the Firebase project

```bash
firebase login
firebase projects:create motiroong
```

Then in the console: enable **Authentication → Email/Password**, and create a
**Firestore** database in `africa-south1`.

Put the real project id in [`.firebaserc`](.firebaserc) (it currently says
`motiroong`).

### 2. Install and build

```bash
cd functions && npm install && npm run build
```

### 3. Run locally

```bash
firebase emulators:start --only functions,firestore,auth
```

Emulator UI at http://localhost:4000. Seed the Mangaung geofences with:

```bash
cd functions && FIRESTORE_EMULATOR_HOST=localhost:8080 node lib/scripts/seed.js
```

### 4. Deploy

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions
```

### 5. Create the first admin

`approveEmployee` needs an admin, and the only way to become one is to be
approved — so break the cycle once, from a trusted machine:

```bash
cd functions
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json \
  node lib/scripts/bootstrap-admin.js admin@example.gov.za 'Admin Name'
```

It prints a single-use password-reset link rather than taking a password, so
no credential ends up in shell history. Download the service account key from
**Project settings → Service accounts**; it is already in `.gitignore` and
must never be committed.

## Configuration

Policy values — geofence radius and tolerance, GPS accuracy threshold, clock
skew limit, max devices per employee, allowed sign-up domains — are collected
in [`functions/src/config.ts`](functions/src/config.ts) rather than scattered
through the handlers.

To restrict sign-up to staff addresses, set:

```ts
allowedEmailDomains: ['mangaung.gov.za'],
```

`enforceSignUpDomain` runs inside Auth *before* the user row is created, so a
rejected address leaves nothing to clean up.

## Note on the stated stack

The mobile README describes an ASP.NET Core + PostgreSQL + Azure backend with
JWT and refresh tokens. This repository replaces that with Firebase. If the
ASP.NET description is still meant to hold — for a project spec or a marking
rubric — that README needs updating, or this needs revisiting.
