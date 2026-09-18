/**
 * Admin SDK singleton.
 *
 * Cloud Functions reuses a warm instance across invocations, so
 * `initializeApp` must run at most once per process.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

if (getApps().length === 0) {
  initializeApp();
}

export const db = getFirestore();
export const auth = getAuth();

/** Collection names, so a typo is a compile error rather than a silent miss. */
export const Collections = {
  employees: 'employees',
  devices: 'devices',
  sites: 'sites',
  attendance: 'attendance',
  exceptions: 'exceptions',
  auditLogs: 'auditLogs',
} as const;

export const employeesRef = () => db.collection(Collections.employees);
export const employeeRef = (uid: string) => employeesRef().doc(uid);
export const devicesRef = (uid: string) =>
  employeeRef(uid).collection(Collections.devices);
export const sitesRef = () => db.collection(Collections.sites);
export const attendanceRef = () => db.collection(Collections.attendance);
export const exceptionsRef = () => db.collection(Collections.exceptions);
export const auditLogsRef = () => db.collection(Collections.auditLogs);
