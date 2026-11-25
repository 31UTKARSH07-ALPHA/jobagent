import { z } from 'zod';
import { transaction, type Db } from '../store/db.ts';
import { nowIso } from '../store/schema.ts';

export const Outcome = z.enum(['Awaiting Response','Replied','Interested','Interview Scheduled','Not Interested','No Response','Bounced']);
export const FollowupCreate = z.object({ date:z.iso.date(), note:z.string().trim().max(2000).default(''), allowUnsent:z.boolean().default(false) });
export const FollowupChange = z.discriminatedUnion('action', [
  z.object({action:z.literal('complete')}), z.object({action:z.literal('note'), note:z.string().trim().min(1).max(2000)}),
  z.object({action:z.enum(['reschedule','snooze']), date:z.iso.date()}),
]);
const result = (status:number,message:string) => ({status,message});
function activity(db:Db, outreach:number, kind:string, detail:string|null, followup:number|null = null, at=nowIso()) {
  db.prepare(`INSERT INTO outreach_activity(outreach_id,followup_id,kind,at,source,detail) VALUES(?,?,?,?,'manual',?)`)
    .run(outreach,followup,kind,at,detail);
}
export function createFollowup(db:Db,id:number,input:z.infer<typeof FollowupCreate>, inTransaction=false) {
  const create=()=>{
    const message=db.prepare('SELECT sent_at FROM outreach WHERE id=?').get(id);
    if (!message) return result(404,'Message not found.');
    if (!message.sent_at && !input.allowUnsent) return result(409,'Explicitly allow a reminder for an unsent message.');
    const at=nowIso();
    const inserted=db.prepare(`INSERT INTO outreach_followups(outreach_id,due_date,status,note,created_at) VALUES(?,?,'Open',?,?)`).run(id,input.date,input.note,at);
    const followup=Number(inserted.lastInsertRowid);
    activity(db,id,'Follow-up created',input.date,followup,at);
    if (input.note) activity(db,id,'Follow-up note added',input.note,followup,at);
    return result(200,'Follow-up saved. No notification or email is scheduled.');
  };
  return inTransaction ? create() : transaction(db,create);
}
export function changeFollowup(db:Db,id:number,input:z.infer<typeof FollowupChange>) {
  return transaction(db,()=>{
    const row=db.prepare('SELECT outreach_id,status FROM outreach_followups WHERE id=?').get(id);
    if (!row) return result(404,'Follow-up not found.');
    const outreach=Number(row.outreach_id), at=nowIso();
    if (input.action==='note') {
      db.prepare('UPDATE outreach_followups SET note=? WHERE id=?').run(input.note,id);
      activity(db,outreach,'Follow-up note added',input.note,id,at);
    } else {
      if (row.status==='Completed') return result(409,'Completed follow-ups cannot be rescheduled. Create a new one instead.');
      if (input.action==='complete') {
        db.prepare("UPDATE outreach_followups SET status='Completed',completed_at=? WHERE id=?").run(at,id);
        activity(db,outreach,'Follow-up completed',null,id,at);
      } else {
        if (input.action==='snooze' && input.date<=localDay()) return result(400,'Choose a future date to snooze.');
        db.prepare('UPDATE outreach_followups SET status=?,due_date=? WHERE id=?').run(input.action==='snooze'?'Snoozed':'Open',input.date,id);
        activity(db,outreach,input.action==='snooze'?'Follow-up snoozed':'Follow-up rescheduled',input.date,id,at);
      }
    }
    return result(200,'Follow-up updated.');
  });
}
export function setOutcome(db:Db,id:number,outcome:z.infer<typeof Outcome>|null) {
  return transaction(db,()=>{
    const row=db.prepare(`SELECT o.sent_at,x.outcome FROM outreach o LEFT JOIN outreach_outcomes x ON x.outreach_id=o.id WHERE o.id=?`).get(id);
    if (!row) return result(404,'Message not found.');
    if (!row.sent_at) return result(409,'Communication outcomes require a recorded send.');
    if ((row.outcome??null)===outcome) return result(200,'Outcome unchanged.');
    const at=nowIso();
    if (outcome) db.prepare(`INSERT INTO outreach_outcomes VALUES(?,?,?) ON CONFLICT(outreach_id) DO UPDATE SET outcome=excluded.outcome,recorded_at=excluded.recorded_at`).run(id,outcome,at);
    else db.prepare('DELETE FROM outreach_outcomes WHERE outreach_id=?').run(id);
    activity(db,id,'Outcome changed',`${row.outcome??'No manual outcome'} → ${outcome??'No manual outcome'}`,null,at);
    return result(200,'Manual outcome updated.');
  });
}
function localDay(now=new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}
export function trackingData(db:Db,now=new Date()) {
  const today=localDay(now);
  const followups=db.prepare(`SELECT f.*,o.application_id,j.title,c.name AS company,o.subject FROM outreach_followups f
    JOIN outreach o ON o.id=f.outreach_id JOIN jobs j ON j.id=o.job_id JOIN companies c ON c.id=j.company_id
    ORDER BY f.due_date,f.id`).all();
  const activity=db.prepare('SELECT * FROM outreach_activity ORDER BY at DESC,id DESC').all();
  const analytics=db.prepare(`SELECT count(*) AS total,
    count(*) FILTER(WHERE o.sent_at IS NULL AND o.gmail_draft_id IS NOT NULL AND o.archived_at IS NULL AND j.state IN ('DRAFTED','PENDING_APPROVAL','AUTO_SEND')) AS drafts,
    count(o.sent_at) AS sent, count(*) FILTER(WHERE o.sent_at IS NOT NULL AND o.send_confirmed=1) AS confirmedSent,
    count(*) FILTER(WHERE o.sent_at IS NOT NULL AND o.send_confirmed=1 AND (o.replied_at IS NOT NULL OR x.outcome IN ('Replied','Interested','Interview Scheduled','Not Interested'))) AS confirmedCohortResponses,count(o.replied_at) FILTER(WHERE o.sent_at IS NOT NULL) AS recordedReplies,
    (SELECT count(DISTINCT outreach_id) FROM outreach_activity WHERE kind='Reply recorded' AND source='integration') AS confirmedReplies,
    count(*) FILTER(WHERE o.sent_at IS NOT NULL AND o.replied_at IS NULL AND x.outcome IN ('Replied','Interested','Interview Scheduled','Not Interested')) AS manualOnlyReplies,
    count(*) FILTER(WHERE x.outcome IN ('Interested','Interview Scheduled')) AS positive,
    count(*) FILTER(WHERE x.outcome='Interview Scheduled') AS interviews,
    (SELECT count(*) FROM outreach_followups WHERE status='Completed') AS completed
    FROM outreach o JOIN jobs j ON j.id=o.job_id LEFT JOIN outreach_outcomes x ON x.outreach_id=o.id`).get();
  return {today,followups,activity,analytics};
}
