# MoTiroong — Firebase setup, on a no-cost account

This is the practical companion to [`README.md`](README.md). The README explains
*why* the backend is built the way it is; this explains how to stand it up when
you are not paying for anything yet.

Read the first section before you click anything in the console. It changes the
order you do things in.

---

## 0. The one thing that decides your whole plan

**The Spark (no-cost) plan does not include Cloud Functions at all.** Not a
reduced quota — none. The pricing table lists Cloud Functions as *not
applicable* on the free plan, and it has been Blaze-only since 2020.

That matters more here than it would in most projects, because this backend is
*entirely* callable functions. `firestore.rules` denies every client write by
design — if the app could write to `attendance/` directly, an employee could
fabricate a shift from their couch. So on Spark, the app can read its own
profile and the site geofences, and can do nothing else. No clock-in, no
sign-up profile, no device binding.

You have three honest options.

### Option A — Emulator-first (recommended, and what this guide assumes)

Build, test and demo the entire system on the **Firebase Local Emulator
Suite**: Auth, Firestore and Functions all run on your MacBook. It is free, it
needs no billing account and no card, and it runs the real function code — the
same `clockIn`, the same rules, the same geofence maths. Your Hisense phone
talks to it over your Wi-Fi.

For a project in the design/implementation phase with a two-person team, this
is not a compromise. It is how you should be working anyway: no cold starts, no
deploy wait, and you can wipe the database between test runs.

You only need a real Firebase project for two things: the Auth and Firestore
*configuration* the app compiles against (`firebase_options.dart`), and the day
the municipality wants to touch it. Both are covered below.

### Option B — Blaze with a hard budget cap

Blaze requires a card, but it *includes* the free quotas rather than replacing
them: 2M function invocations/month, 400,000 GB-seconds, 5 GB egress, plus the
same Firestore allowance as Spark (50K reads/day, 20K writes/day, 1 GiB).

Run the numbers for this app. A 200-person depot clocking twice a day, 22 days
a month, is **8,800 invocations a month** — 0.44% of the free allowance. Add
profile loads, history pages and the nightly sweep and you are still under 1%.
The compute is genuinely free at this scale.

What is *not* guaranteed to be exactly zero: 2nd-gen functions build a
container image per deploy and store it in Artifact Registry, whose free tier
is 0.5 GB. Deploy often enough and you will see a bill of a few US cents. Fix
it once, with the cleanup policy in §7.

### Option C — Rewrite without functions

Drop the callables, let the app write to Firestore directly, and enforce what
you can in security rules.

**Don't.** Rules can check `request.time == request.resource.data.clockInAt` and
stop a user writing another user's record, but they cannot do the three things
this system exists for: compute the geofence verdict from the site record,
compare a device secret hash in constant time, or mint a custom token — that
needs a service account, which cannot live in a phone. You would be building an
attendance system whose records the phone authors. For a municipal payroll
input, that is not a system with a weakness; it is not a system.

If you are ever pushed to do this by a deadline, say so and I will show you
exactly how much of the integrity survives. It is less than you would hope.

**Recommendation: Option A now, Option B the week before handover.**

---

## 1. Create the project

In the [Firebase console](https://console.firebase.google.com):

1. **Add project** → name it `MoTiroong`. The console will suggest a project ID
   like `motiroong-4f2a1`; **write it down**, it is what goes in `.firebaserc`.
2. Google Analytics: **off**. You do not need it, and for a government client
   collecting staff location data, an analytics SDK is one more thing to
   justify in a POPIA assessment.
3. Stay on the **Spark** plan when prompted.

### Firestore

**Build → Firestore Database → Create database.**

- Mode: **Production** (locked). The rules in this repo replace the defaults.
- Location: **`africa-south1` (Johannesburg)**.

That location is not a latency preference, it is the POPIA answer. Section 72
of POPIA restricts transferring personal information outside South Africa
without an adequate-protection basis, and this database holds staff names,
employee numbers and a log of where each person physically stood, twice a day.
`africa-south1` keeps it in Johannesburg. **The location cannot be changed
after creation** — a wrong choice here means a new project, so get it right the
first time.

### Authentication

**Build → Authentication → Get started → Email/Password → Enable.**

Leave "Email link (passwordless)" off. Do *not* enable Google or any social
provider: sign-up is gated on admin approval, and a one-tap Google button
invites strangers to create pending accounts your admin then has to clear.

### Register the apps

**Project settings → Your apps.** Add:

- **Android** — package name from
  `motiroong-mobile/android/app/build.gradle.kts` (`applicationId`).
- **iOS** — bundle ID from Xcode / `ios/Runner.xcodeproj`.
- **Web** — only if you build the admin console as a web app (§8). Do it now
  anyway; it costs nothing and saves a round trip later.

You do not need to download `google-services.json` or `GoogleService-Info.plist`
by hand. `flutterfire configure` in the next step fetches them.

---

## 2. Point the repos at the project

```bash
# Backend
cd ~/Desktop/motiroong-backend
# edit .firebaserc: replace "motiroong" with your real project ID
firebase login
firebase use --add            # pick the project, alias it "default"
```

```bash
# Mobile
dart pub global activate flutterfire_cli
cd ~/Desktop/motiroong-mobile
flutterfire configure --project=<your-project-id>
```

`flutterfire configure` writes `lib/firebase_options.dart` and drops
`google-services.json` and `GoogleService-Info.plist` in place. **The app will
not compile until you have run it** — `main.dart` imports
`firebase_options.dart` and that file does not exist yet.

Commit all three. They are client configuration, not secrets: an API key in a
Firebase config identifies the project, it does not authorise anything. What
guards your data is `firestore.rules` and the guards in the callables. The one
file that *is* a secret is `serviceAccountKey.json` (§6), and it is already in
`.gitignore`.

---

## 3. Build the functions

```bash
cd ~/Desktop/motiroong-backend/functions
npm install
npm run build
```

Nothing is deployed yet. This only compiles TypeScript to `lib/`, which is what
the emulator runs.

---

## 4. Run everything locally

```bash
cd ~/Desktop/motiroong-backend
./emulators.sh
```

This wraps `firebase emulators:start` with `--import`/`--export-on-exit`, so
Auth users and Firestore documents survive a restart in `./.emulator-data`
(gitignored). That matters more than it sounds: without it every restart wipes
your admin account, and because `approveEmployee` requires an already-active
admin, the only way back is to recreate it by hand in the Emulator UI. The
export runs on a clean shutdown, so stop the suite with Ctrl-C rather than
killing it. Delete `.emulator-data` to start from a blank slate.

The script also resolves a Homebrew-installed JDK that is not linked onto the
PATH — the Firestore emulator is a Java process, and an unlinked `openjdk`
surfaces as a confusing "Unable to locate a Java Runtime".

Emulator UI: <http://localhost:4000>. You get a Firestore browser, an Auth user
list, and function logs — considerably better visibility than the real console.

Seed the Mangaung geofences into the emulator:

```bash
cd functions
FIRESTORE_EMULATOR_HOST=localhost:8080 node lib/scripts/seed.js
```

### Point the app at the emulator

```bash
# iOS simulator or Chrome
flutter run --dart-define=USE_EMULATORS=true

# Android emulator — its "localhost" is the emulator itself
flutter run --dart-define=USE_EMULATORS=true --dart-define=EMULATOR_HOST=10.0.2.2

# Your Hisense over USB — use the Mac's LAN IP (ipconfig getifaddr en0)
flutter run --dart-define=USE_EMULATORS=true --dart-define=EMULATOR_HOST=192.168.1.42
```

Biometrics and GPS are real on the phone even against the emulator, so the full
clock-in path — fingerprint → device secret → custom token → geofence verdict —
is genuinely testable without a cent of billing.

### Make an admin in the emulator

The bootstrap script needs a service account against the real project, so in
the emulator take the shortcut instead: sign up a user in the app, then in the
Emulator UI open `employees/{uid}` and set `status: "active"`,
`role: "admin"`. Claims are stamped from Firestore on the next
`getMyProfile`, so sign out and back in.

This is a one-time bootstrap, not the normal path. With `./emulators.sh` the
admin account persists across restarts, so every employee after this one gets
approved in the admin console (`admin-motiroong`, which is already pointed at
the emulator via `NEXT_PUBLIC_USE_EMULATORS`) through `approveEmployee` —
exactly as it works against the deployed project.

---

## 5. What Spark actually gives you

Worth knowing even on the emulator path, because these are the ceilings the
deployed app will live under:

| Service | Spark allowance | This app's realistic use |
|---|---|---|
| Firestore reads | 50,000 / day | ~10 per clock action + history paging |
| Firestore writes | 20,000 / day | 2 per employee per day, plus audit logs |
| Firestore storage | 1 GiB | An attendance record is ~500 bytes — roughly 2 million shifts |
| Auth | 50,000 MAU | Mangaung Metro employs nowhere near this |
| Hosting | 10 GB, 360 MB/day | Fine for the admin console |
| **Cloud Functions** | **none** | **the entire backend** |

Every row except the last is comfortable for a metro. The last one is the whole
argument in §0.

---

## 6. When you do deploy (Blaze)

Only from here does anything cost money. Before you run this, do §7.

```bash
cd ~/Desktop/motiroong-backend
firebase deploy --only firestore:rules,firestore:indexes,functions
```

Then create the first admin. `approveEmployee` needs an admin, and the only way
to become one is to be approved, so you break the cycle once from a trusted
machine:

```bash
# Project settings → Service accounts → Generate new private key
cd functions
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json \
  node lib/scripts/bootstrap-admin.js admin@mangaung.gov.za 'Jabulile Mashibini'
```

It prints a single-use password-reset link rather than taking a password, so no
credential lands in your shell history. The key file is already in
`.gitignore`. **Never commit it** — it is full admin access to every record in
the project, and a leaked one on GitHub is found by scrapers in minutes.

### Do not deploy `enforceSignUpDomain` yet

`beforeUserCreated` is a **blocking function**, and blocking functions require
upgrading the project to *Firebase Authentication with Identity Platform*,
which is a separate (billed) tier. It is currently a no-op anyway —
`Config.signUp.allowedEmailDomains` is empty. Leave it out until the
municipality asks for domain restriction:

```bash
firebase deploy --only functions:clockIn,functions:clockOut,functions:getClockStatus,...
```

or comment the export out of `functions/src/index.ts`.

---

## 7. Cost control before your first deploy

Three things, in this order.

**1. Cap concurrency.** Nothing in this app needs to scale, and an uncapped
function is the only way a bug turns into a bill. Add to the top of
`functions/src/index.ts`:

```ts
import { setGlobalOptions } from 'firebase-functions/v2';

setGlobalOptions({
  region: Config.region,
  maxInstances: 10,   // a runaway loop costs a rand, not a salary
  memory: '256MiB',   // these handlers do Firestore reads and arithmetic
});
```

**2. Clean up build artifacts.** 2nd-gen deploys leave a container image in
Artifact Registry each time; the free tier is 0.5 GB and the images are not
needed at runtime.

```bash
firebase functions:artifacts:setpolicy --days 1
```

**3. Set a budget alert.** Google Cloud console → Billing → Budgets & alerts →
new budget of **R50/month**, alerts at 50%, 90%, 100%. This *notifies*, it does
not cap — there is no hard spending limit on Blaze, which is exactly why the
first two steps matter.

---

## 8. `admin-motiroong` — the console that doesn't exist yet

The backend already has every function the admin side needs; there is nothing
to add server-side except a Hosting target.

| Screen | Callables |
|---|---|
| Pending approvals | `listPendingEmployees`, `approveEmployee`, `rejectEmployee` |
| Staff list | `setEmployeeStatus`, `setEmployeeRole`, `revokeDevice` |
| Sites & geofences | `listSites`, `upsertSite`, `archiveSite` |
| Exception review | `listPendingExceptions`, `reviewException` |
| Attendance reports | Firestore reads on `attendance/` (admin-readable) |
| Audit trail | Firestore reads on `auditLogs/` |

Suggested shape, given the constraint that Hosting is free on Spark:

- **Flutter web**, reusing `motiroong-mobile`'s theme, models and
  `FunctionsClient` verbatim. One language, one set of models, and the wire
  shapes stay in step by construction. React would mean maintaining a second
  copy of every model in TypeScript.
- Deployed to **Firebase Hosting** on the same project, so the callables are
  same-project and the admin's ID token carries the `admin` claim the functions
  already check.
- Guard the whole app on `role == 'admin' || role == 'supervisor'` from
  `getMyProfile`, and remember that is a *UI* guard — the real enforcement is in
  `requireAdmin` on the backend, where it belongs.

The one backend addition worth making: a paged `listEmployees` and a
`listAttendance` with date and site filters. Right now the console would have to
query Firestore directly for those, which works (rules allow admin reads) but
splits the API surface in two.

---

## 9. What's still missing in the mobile app

The data layer is now wired to Firebase — `AuthRepository`, `AttendanceRepository`,
`FunctionsClient`, the models and both providers all talk to the real backend.
Three screens do not exist yet:

- **Sign-up** — `AuthRepository.signUp()` is written and ready; there is no form
  calling it. Until there is, accounts have to be made in the console.
- **Pending approval** — a signed-in `pending` user currently lands on the home
  screen and gets a clear error from `clockIn` when they tap. It works, but it
  reads as a fault rather than a status. `AuthProvider.awaitingApproval` is
  there for the screen that fixes it.
- **Device enrolment** — `lib/features/auth/presentation/screens/device_enrollment_screen.dart`
  is an empty file. `AuthProvider.enrollBiometrics()` is the call it needs.

`connectivity_service.dart` and `offline_queue_service.dart` are also still
empty, and they matter more than they look: municipal depots have poor signal,
and the `late_sync` flag in `types.ts` exists precisely because the backend
already expects events queued offline and submitted later.

---

## Sources

- [Firebase pricing](https://firebase.google.com/pricing) — Spark excludes Cloud Functions; Spark/Blaze quotas
- [Cloud Firestore locations](https://firebase.google.com/docs/firestore/locations) — `africa-south1` (Johannesburg)
- [Cloud Functions locations](https://firebase.google.com/docs/functions/locations) — `africa-south1`, 2nd gen only, Tier 1
- [Extend Firebase Authentication with blocking functions](https://firebase.google.com/docs/auth/extend-with-blocking-functions) — requires Identity Platform
- [Manage functions](https://firebase.google.com/docs/functions/manage-functions) — Artifact Registry cleanup policy
