/**
 * Tunable policy values.
 *
 * These are the numbers a municipality will argue about, so they live in one
 * file rather than being sprinkled through the handlers.
 */
export const Config = {
  /** Cloud Functions region. Johannesburg — closest to Mangaung. */
  region: 'africa-south1',

  geofence: {
    /** Used when a site has no explicit radius set. */
    defaultRadiusMeters: 150,
    /**
     * A GPS fix worse than this is not trustworthy enough to judge a
     * geofence by, so the event is flagged `low_gps_accuracy` instead of
     * `outside_geofence` — we don't punish someone for a bad signal.
     */
    maxAccuracyMeters: 100,
    /**
     * Grace added to the radius before flagging. Absorbs ordinary GPS drift
     * at a building entrance.
     */
    toleranceMeters: 25,
  },

  attendance: {
    /** Device/server clock disagreement above this is flagged `clock_skew`. */
    maxClockSkewMinutes: 10,
    /** An offline event synced later than this is flagged `late_sync`. */
    lateSyncMinutes: 60,
    /**
     * Shifts longer than this are closed automatically by the nightly job —
     * someone forgot to clock out.
     */
    maxShiftHours: 16,
    /** Ignore a second clock-in within this window as a double tap. */
    duplicateWindowSeconds: 90,
  },

  device: {
    /** Biometric sign-ins a device may fail before it must re-enrol. */
    maxFailedAttempts: 5,
    /** Devices one employee may bind at once. */
    maxPerEmployee: 3,
    /** Hex characters expected in the device secret (32 bytes). */
    secretHexLength: 64,
  },

  signUp: {
    /** Domains allowed to self-register. Empty array = allow any. */
    allowedEmailDomains: [] as string[],
    /** Minimum password length enforced server-side as well as in the app. */
    minPasswordLength: 8,
  },
} as const;
