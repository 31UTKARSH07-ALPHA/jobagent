import { z } from 'zod';
import { transaction, type Db } from '../store/db.ts';
import { createFollowup } from './tracking.ts';
import { nowIso, Timestamp } from '../store/schema.ts';

export const DraftFields = z.object({
  email: z.string().trim().email().max(254),
  subject: z.string().trim().min(1).max(250).regex(/^[^\u0000-\u001f\u007f]+$/u),
  body: z.string().trim().min(1).max(20_000).refine((value) => !value.includes('\0')),
});
export const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const EditDraft = DraftFields.extend({ revision: Revision });
export const ApplicationInput = z.object({
  applicationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  create: z.boolean().optional(),
  allowUnsent: z.boolean().optional(),
  followUpAt: Timestamp.nullable().optional(),
}).refine(({ create, applicationId }) => !create || applicationId == null);

export const MUTABLE = `o.sent_at IS NULL AND o.approved_at IS NULL AND o.gmail_draft_id IS NOT NULL
  AND o.delete_requested_at IS NULL AND o.archived_at IS NULL AND j.state IN ('DRAFTED','PENDING_APPROVAL')`;

export function saveDraft(db: Db, id: number, fields: z.infer<typeof EditDraft>) {
  // The local working copy cannot be approved against the older Gmail draft.
  const { changes } = db.prepare(`UPDATE outreach AS o SET local_subject=?,local_body=?,recipient_override=?,revision=revision+1,edit_pending=1
    WHERE o.id=? AND o.revision=? AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=o.job_id AND ${MUTABLE})`)
    .run(fields.subject, fields.body, fields.email, id, fields.revision);
  return changes ? { status: 200, message: 'Saved locally. The Gmail copy is unchanged and JobAgent will not queue it.' }
    : { status: 409, message: 'This draft changed or cannot be edited. Refresh before saving.' };
}

export function regenerateDraft(db: Db, id: number) {
  const row = db.prepare(`SELECT j.title,c.name FROM outreach o JOIN jobs j ON j.id=o.job_id
    JOIN companies c ON c.id=j.company_id WHERE o.id=? AND ${MUTABLE}`).get(id);
  if (!row) return null;
  const title = String(row.title).replace(/\s+/g, ' '), company = String(row.name).replace(/\s+/g, ' ');
  return { subject: `${title} at ${company}`.slice(0, 250), body: `Hi ${company} team,\n\nI’m writing about the ${title} opening at ${company}. I’d like to learn what the team is looking for and how best to apply.\n\nIf there’s a preferred application process or a person I should contact, I’d appreciate the pointer.\n\nThank you for your time.` };
}

export function updateApplication(db: Db, id: number, input: z.infer<typeof ApplicationInput>) {
  let addReminder = false;
  const result = transaction(db, () => {
    const row = db.prepare(`SELECT o.job_id,o.application_id,o.follow_up_at,o.sent_at,CASE WHEN o.sent_at IS NULL THEN COALESCE(o.recipient_override,k.email) ELSE k.email END AS recipient FROM outreach o JOIN contacts k ON k.id=o.contact_id WHERE o.id=?`).get(id);
    if (!row) return { status: 404, message: 'Outreach record not found.' };
    if (input.followUpAt && input.followUpAt !== row.follow_up_at && !row.sent_at && !input.allowUnsent) return {status:409,message:'Explicitly allow a reminder for an unsent message.'};
    let app = input.applicationId === undefined ? row.application_id : input.applicationId;
    if (input.create) {
      db.prepare('INSERT INTO applications(job_id,created_at,recipient) VALUES(?,?,?) ON CONFLICT(job_id) DO NOTHING').run(row.job_id!, nowIso(), row.recipient ?? null);
      app = db.prepare('SELECT id FROM applications WHERE job_id=?').get(row.job_id!)!.id;
    }
    if (app != null && !db.prepare('SELECT id FROM applications WHERE id=?').get(app)) return { status: 404, message: 'Application not found.' };
    addReminder = !!input.followUpAt && input.followUpAt !== row.follow_up_at;
    db.prepare('UPDATE outreach SET application_id=?,follow_up_at=? WHERE id=?').run(app ?? null,
      input.followUpAt === undefined ? row.follow_up_at ?? null : input.followUpAt, id);
    if (addReminder && input.followUpAt) createFollowup(db,id,{date:input.followUpAt.slice(0,10),note:'',allowUnsent:input.allowUnsent??false}, true);
    return { status: 200, message: 'Outreach details updated.' };
  });
  return result;
}

export function archiveDraft(db: Db, id: number, archived: boolean) {
  const { changes } = db.prepare(`UPDATE outreach AS o SET archived_at=? WHERE id=? AND sent_at IS NULL
    AND approved_at IS NULL AND delete_requested_at IS NULL AND gmail_draft_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM jobs WHERE id=o.job_id AND state IN ('DRAFTED','PENDING_APPROVAL'))`)
    .run(archived ? nowIso() : null, id);
  return changes ? { status: 200, message: archived ? 'Archived. The Gmail draft is still intact.' : 'Draft restored.' }
    : { status: 409, message: 'Queued, sent, or unavailable drafts cannot be archived or restored.' };
}
