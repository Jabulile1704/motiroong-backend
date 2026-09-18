/**
 * Site (geofence) administration.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { onCall } from 'firebase-functions/v2/https';

import { Config } from '../config';
import { writeAudit } from '../lib/audit';
import {
  notFound,
  optionalString,
  requireNumber,
  requireString,
} from '../lib/errors';
import { sitesRef } from '../lib/firebase';
import { requireActiveEmployee, requireRole } from '../lib/guards';
import type { SiteDoc } from '../types';

/** Active sites, for the map and the site picker. Any active employee. */
export const listSites = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    await requireActiveEmployee(request);
    const snapshot = await sitesRef().where('active', '==', true).get();

    return {
      sites: snapshot.docs
        .map((doc) => doc.data() as SiteDoc)
        .map((s) => ({
          siteId: s.siteId,
          name: s.name,
          address: s.address,
          latitude: s.latitude,
          longitude: s.longitude,
          radiusMeters: s.radiusMeters || Config.geofence.defaultRadiusMeters,
        })),
    };
  },
);

/** Creates or updates a site. Admins only. */
export const upsertSite = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireRole(request, 'admin');
    const data = request.data ?? {};

    const name = requireString(data.name, 'Site name', { max: 120 });
    const latitude = requireNumber(data.latitude, 'Latitude', {
      min: -90,
      max: 90,
    });
    const longitude = requireNumber(data.longitude, 'Longitude', {
      min: -180,
      max: 180,
    });
    const radiusMeters = requireNumber(
      data.radiusMeters ?? Config.geofence.defaultRadiusMeters,
      'Radius',
      { min: 20, max: 10_000 },
    );
    const address = optionalString(data.address, 250);
    const siteId = optionalString(data.siteId, 64);

    const ref = siteId ? sitesRef().doc(siteId) : sitesRef().doc();
    const exists = siteId ? (await ref.get()).exists : false;

    await ref.set(
      {
        siteId: ref.id,
        name,
        address,
        latitude,
        longitude,
        radiusMeters,
        active: true,
        ...(exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await writeAudit({
      action: exists ? 'site.updated' : 'site.created',
      actorUid: caller.uid,
      actorEmail: caller.email,
      targetId: ref.id,
      metadata: { name, latitude, longitude, radiusMeters },
    });

    return { siteId: ref.id, name, radiusMeters };
  },
);

/**
 * Archives a site.
 *
 * Soft delete, because attendance records reference `siteId` and a hard
 * delete would leave historical shifts pointing at nothing.
 */
export const archiveSite = onCall(
  { region: Config.region, cors: true },
  async (request) => {
    const caller = await requireRole(request, 'admin');
    const siteId = requireString(request.data?.siteId, 'Site', { max: 64 });

    const ref = sitesRef().doc(siteId);
    if (!(await ref.get()).exists) {
      throw notFound('That site does not exist.');
    }

    await ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit({
      action: 'site.archived',
      actorUid: caller.uid,
      actorEmail: caller.email,
      targetId: siteId,
    });

    return { siteId, archived: true };
  },
);
