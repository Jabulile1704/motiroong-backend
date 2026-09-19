/**
 * Tests for the decisions that cannot be re-checked by eye.
 *
 * Scope is deliberate: everything here is a pure function, so these run with
 * `node --test` against the compiled output and need no emulator, no
 * credentials and no network. That matters because the emulator suite needs a
 * Java download and a Blaze project to be useful, and these checks should run
 * on any laptop, on any branch, in seconds.
 *
 * What is covered is the arithmetic that decides whether an employee gets
 * flagged — the geofence verdict, the accuracy threshold, the clock-skew
 * window — and the constant-time secret comparison that biometric sign-in
 * rests on. Those are the parts where a wrong answer is both plausible and
 * invisible: nobody notices a haversine that is 8% out until payroll disputes
 * a month of shifts.
 *
 * The clock and device handlers are not tested here; they are mostly Firestore
 * choreography and want the emulator.
 *
 *   npm test
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  chooseNearestSite,
  clockSkewFlags,
  distanceMeters,
  evaluateGeofence,
  parseGeoPoint,
} from '../lib/lib/geo.js';
import {
  hashPin,
  hashSecret,
  hashesMatch,
  isTrivialPin,
  requireDeviceSecret,
  requirePin,
} from '../lib/lib/crypto.js';
import { Config } from '../lib/config.js';

/** Bloemfontein city hall, and a point roughly 1 km due north of it. */
const CITY = { lat: -29.121, lng: 26.214 };
const NORTH_1KM = { lat: -29.112, lng: 26.214 };

const site = {
  siteId: 'depot',
  name: 'Bloemfontein Depot',
  address: null,
  latitude: CITY.lat,
  longitude: CITY.lng,
  radiusMeters: 150,
  active: true,
  createdAt: null,
  updatedAt: null,
};

const at = (lat, lng, accuracy = 10, when = new Date()) => ({
  latitude: lat,
  longitude: lng,
  accuracyMeters: accuracy,
  capturedAt: when.toISOString(),
});

describe('distanceMeters', () => {
  test('measures a known 1 km separation', () => {
    const d = distanceMeters(CITY.lat, CITY.lng, NORTH_1KM.lat, NORTH_1KM.lng);
    assert.ok(d > 990 && d < 1010, `expected ~1000 m, got ${d.toFixed(1)}`);
  });

  test('is zero for the same point', () => {
    assert.ok(distanceMeters(CITY.lat, CITY.lng, CITY.lat, CITY.lng) < 0.001);
  });
});

describe('evaluateGeofence', () => {
  test('on site is inside and unflagged', () => {
    const result = evaluateGeofence(at(CITY.lat, CITY.lng), site);
    assert.equal(result.inside, true);
    assert.deepEqual(result.flags, []);
  });

  test('a kilometre away is outside and flagged', () => {
    const result = evaluateGeofence(at(NORTH_1KM.lat, NORTH_1KM.lng), site);
    assert.equal(result.inside, false);
    assert.ok(result.flags.includes('outside_geofence'));
  });

  test('the tolerance absorbs ordinary drift at a building entrance', () => {
    // ~160 m out, against a 150 m radius and 25 m of tolerance.
    const result = evaluateGeofence(at(CITY.lat + 0.00144, CITY.lng), site);
    assert.ok(
      !result.flags.includes('outside_geofence'),
      `flagged at ${result.distanceMeters?.toFixed(1)} m`,
    );
  });

  test('a poor fix is low_gps_accuracy, never outside_geofence', () => {
    // The distinction is the point: we do not punish someone for a bad signal
    // under a tin roof, because a 500 m fix cannot tell us where they were.
    const result = evaluateGeofence(at(NORTH_1KM.lat, NORTH_1KM.lng, 500), site);
    assert.ok(result.flags.includes('low_gps_accuracy'));
    assert.ok(!result.flags.includes('outside_geofence'));
  });
});

describe('chooseNearestSite', () => {
  test('picks the nearer site', () => {
    const far = { ...site, siteId: 'yard', name: 'Yard', latitude: CITY.lat + 0.05 };
    const chosen = chooseNearestSite(at(CITY.lat, CITY.lng), [far, site], null);
    assert.equal(chosen?.siteId, 'depot');
  });

  test('returns null when no sites are configured', () => {
    assert.equal(chooseNearestSite(at(CITY.lat, CITY.lng), [], null), null);
  });
});

describe('clockSkewFlags', () => {
  test('an honest phone clock is not flagged', () => {
    const now = new Date();
    assert.deepEqual(clockSkewFlags(at(0, 0, 10, now), now), []);
  });

  test('a phone wound back an hour is flagged', () => {
    const now = new Date();
    const wound = new Date(now.getTime() - 60 * 60 * 1000);
    assert.ok(clockSkewFlags(at(0, 0, 10, wound), now).includes('clock_skew'));
  });
});

describe('parseGeoPoint', () => {
  test('accepts the camelCase payload the app sends', () => {
    const point = parseGeoPoint({
      latitude: 1,
      longitude: 2,
      accuracyMeters: 5,
      capturedAt: new Date().toISOString(),
    });
    assert.equal(point.accuracyMeters, 5);
  });

  test('still accepts the older accuracy_m / timestamp spelling', () => {
    const point = parseGeoPoint({
      latitude: 1,
      longitude: 2,
      accuracy_m: 5,
      timestamp: new Date().toISOString(),
    });
    assert.equal(point.accuracyMeters, 5);
  });

  test('rejects an impossible latitude', () => {
    assert.throws(() =>
      parseGeoPoint({ latitude: 999, longitude: 2, accuracyMeters: 5 }),
    );
  });

  test('rejects a missing location', () => {
    assert.throws(() => parseGeoPoint(null));
  });
});

describe('device secrets', () => {
  const secret = 'a'.repeat(64);
  const other = 'b'.repeat(64);

  test('hashes to 64 hex characters, deterministically', () => {
    assert.match(hashSecret(secret), /^[0-9a-f]{64}$/);
    assert.equal(hashSecret(secret), hashSecret(secret));
    assert.notEqual(hashSecret(secret), hashSecret(other));
  });

  test('compares matching and mismatched hashes correctly', () => {
    assert.equal(hashesMatch(hashSecret(secret), hashSecret(secret)), true);
    assert.equal(hashesMatch(hashSecret(secret), hashSecret(other)), false);
  });

  test('a revoked device, whose hash was cleared, never matches', () => {
    // revokeDevice blanks secretHash. If an empty hash could match, revoking
    // a lost phone would hand it a permanent key.
    assert.equal(hashesMatch('', hashSecret(secret)), false);
  });

  test('rejects a secret that is not 32 bytes of hex', () => {
    assert.throws(() => requireDeviceSecret('short'));
    assert.equal(requireDeviceSecret(secret), secret);
  });
});

describe('config', () => {
  test('region matches the Firestore location', () => {
    assert.equal(Config.region, 'africa-south1');
  });

  test('the nightly sweep threshold is a plausible shift length', () => {
    assert.ok(Config.attendance.maxShiftHours >= 8);
    assert.ok(Config.attendance.maxShiftHours <= 24);
  });
});

describe('sign-in PINs', () => {
  const secret = 'a'.repeat(64);
  const other = 'b'.repeat(64);

  test('the same PIN on a different device hashes differently', () => {
    assert.notEqual(hashPin(secret, '482915'), hashPin(other, '482915'));
  });

  test('a correct PIN matches and a wrong one does not', () => {
    const stored = hashPin(secret, '482915');
    assert.ok(hashesMatch(stored, hashPin(secret, '482915')));
    assert.ok(!hashesMatch(stored, hashPin(secret, '482916')));
  });

  test('rejects anything but exactly six digits', () => {
    for (const bad of ['12345', '1234567', '48291a', '', 482915, null]) {
      assert.throws(() => requirePin(bad));
    }
    assert.equal(requirePin('482915'), '482915');
  });

  test('refuses the PINs everyone tries first', () => {
    for (const trivial of ['000000', '777777', '123456', '654321', '345678']) {
      assert.ok(isTrivialPin(trivial), trivial);
      assert.throws(() => requirePin(trivial));
    }
    assert.ok(!isTrivialPin('482915'));
    assert.ok(!isTrivialPin('112233'));
  });
});
