# Deploying without paying

Cloud Functions requires the Blaze plan. Firebase Auth and Firestore do not —
they are free on Spark, permanently, with no card. So the data and the
accounts live in the real `motirong-32a1c` project, and only the *compute*
moves somewhere else free.

That move is small, because an `onCall` handler is already an Express request
handler: it verifies the caller's ID token itself and writes the callable wire
format. `functions/src/server.ts` mounts all 25 of them unmodified, and both
clients already speak that protocol. Nothing about the handlers changes, and
moving back to Cloud Functions later is a config change, not a rewrite.

## 1. Create a service account key

Firebase Console → Project settings → Service accounts → **Generate new
private key**. Save it as `functions/serviceAccountKey.json` — already
gitignored.

Encode it, because dashboards mangle newlines in multi-line values:

```bash
base64 -i functions/serviceAccountKey.json | pbcopy
```

## 2. Deploy the server

Push this repo to GitHub, then on <https://render.com> → New → Blueprint, pick
the repo. `render.yaml` describes the whole service, so the only thing to fill
in is the environment variable `FIREBASE_SERVICE_ACCOUNT_BASE64` — paste what
you just copied. Render generates `CRON_SECRET` for you.

You get a URL like `https://motiroong-backend.onrender.com`. Open it: it
should list all 25 callables.

```json
{ "service": "motiroong-backend", "count": 25, "callables": ["approveEmployee", ...] }
```

## 3. Deploy the Firestore rules

The rules are what protect the data now, so they must be on the real project:

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

## 4. Seed the sites

```bash
cd functions && GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json GCLOUD_PROJECT=motirong-32a1c node lib/scripts/seed.js
```

No `FIRESTORE_EMULATOR_HOST` here — leaving it off is what makes this write to
the real project.

## 5. Create the first admin

`approveEmployee` requires an admin, and only an admin can make one, so the
first has to be minted directly:

```bash
cd functions && npm run build && GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node lib/scripts/bootstrap-admin.js you@example.com 'Your Full Name'
```

It prints a password-reset link rather than accepting a password, so nothing
ends up in your shell history. Open it and set your password.

Every employee after this one is approved in the dashboard. You should not
need to touch Firestore by hand again.

## 6. Point the clients at it

**Admin dashboard** — in `admin-motiroong/.env.local`:

```
NEXT_PUBLIC_USE_EMULATORS=false
NEXT_PUBLIC_BACKEND_URL=https://motiroong-backend.onrender.com
NEXT_PUBLIC_FIREBASE_API_KEY=<from Project settings → Your apps → Web>
NEXT_PUBLIC_FIREBASE_APP_ID=<same place>
```

Register a Web app in the console first if you have not — those two values
are blank until you do.

**Mobile app** — one dart-define, and no `USE_EMULATORS`:

```bash
flutter run --release --dart-define=BACKEND_URL=https://motiroong-backend.onrender.com
```

## 7. Replace the nightly job

`closeStaleShiftsNightly` was a scheduled function, which needs Cloud
Functions. The same work is exposed as an endpoint:

```
POST /tasks/close-stale-shifts
x-cron-secret: <CRON_SECRET from Render>
```

Point any free cron at it — <https://cron-job.org> or a GitHub Actions
`schedule` — at 02:00 SAST, matching the original. The route refuses to run
when `CRON_SECRET` is unset, so a missing variable fails closed rather than
leaving a public write open.

## What this does not cover

`enforceSignUpDomain` was a **blocking** Auth function, and those need
Identity Platform, which is Blaze-only. It is a no-op today —
`Config.signUp.allowedEmailDomains` is `[]`, meaning any domain — so it is
simply not mounted. If you ever need to restrict sign-up domains, check it
inside `createEmployeeProfile` instead, which runs on your own server.

## Keeping it awake

Free instances sleep after ~15 minutes idle and take about a minute to wake,
which the app reports as "Cannot reach the MoTiroong server". Point a free
uptime pinger at `/` every 10 minutes. The health check touches no Firestore,
so keeping it warm costs nothing.
