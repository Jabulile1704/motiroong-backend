/**
 * Append-only audit trail.
 *
 * Attendance data decides whether people get paid, so every privileged
 * action needs to be answerable later: who approved this employee, who
 * revoked that device, who closed this shift.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { auditLogsRef } from './firebase';

export interface AuditEntry {
  action: string;
  actorUid: string;
  actorEmail?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Writes an audit row.
 *
 * Deliberately never throws: a failed log must not roll back the action it
 * describes, and an approval that half-succeeded would be worse than a
 * missing log line. Failures go to Cloud Logging instead.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await auditLogsRef().add({
      action: entry.action,
      actorUid: entry.actorUid,
      actorEmail: entry.actorEmail ?? null,
      targetId: entry.targetId ?? null,
      at: FieldValue.serverTimestamp(),
      metadata: entry.metadata ?? {},
    });
  } catch (error) {
    console.error('audit write failed', { action: entry.action, error });
  }
}
