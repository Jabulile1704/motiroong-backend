/**
 * Seeds a couple of Mangaung sites so the geofence can be exercised against
 * the emulator. Safe to re-run; it overwrites by id.
 *
 *   cd functions && npm run build
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 node lib/scripts/seed.js
 */
import { FieldValue } from 'firebase-admin/firestore';
import { sitesRef } from '../lib/firebase';

const SITES = [
  {
    siteId: 'bloemfontein-civic',
    name: 'Bram Fischer Building',
    address: 'Nelson Mandela Dr, Bloemfontein',
    latitude: -29.115_1,
    longitude: 26.214_5,
    radiusMeters: 150,
  },
  {
    siteId: 'botshabelo-depot',
    name: 'Botshabelo Depot',
    address: 'Botshabelo, Free State',
    latitude: -29.273_0,
    longitude: 26.719_0,
    radiusMeters: 250,
  },
  {
    siteId: 'thaba-nchu-office',
    name: 'Thaba Nchu Municipal Office',
    address: 'Thaba Nchu, Free State',
    latitude: -29.213_0,
    longitude: 26.828_0,
    radiusMeters: 200,
  },
];

async function main() {
  for (const site of SITES) {
    await sitesRef()
      .doc(site.siteId)
      .set(
        {
          ...site,
          active: true,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    console.log(`seeded site ${site.siteId} — ${site.name}`);
  }
  console.log(`\n${SITES.length} sites ready.`);
}

main().catch((error) => {
  console.error('seed failed:', error);
  process.exit(1);
});
