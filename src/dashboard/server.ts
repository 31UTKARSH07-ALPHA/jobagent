import { internshipRecommendationExclusion } from '../ingest/compensation.ts';
import { type IncomingMessage } from 'node:http';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DEFAULT_DB_PATH, openDb, type Db } from '../store/db.ts';
import { sendingArmed } from '../send/gate.ts';
import { MATCH_THRESHOLD } from '../match/score.ts';
import { deleteDraft, readReplies } from './mail.ts';
import { EditDraft, Revision, ApplicationInput, MUTABLE, saveDraft, regenerateDraft, updateApplication, archiveDraft } from './outreach.ts';
import { trackingData, FollowupCreate, FollowupChange, Outcome, createFollowup, changeFollowup, setOutcome } from './tracking.ts';
import { localReview, ReviewInput } from './local-review.ts';
import { learningIndex, learningData, learningAction, addLearningApplication, learningInputs, parse as parseLearning, LearningError } from './learning.ts';
import { loadProfile } from '../match/profile.ts';
import { nowIso } from '../store/schema.ts';
import { dashboardConfig, hostedDbPath, ownerAuth, redirect } from './auth.ts';

const publicAssets = new Map<string, readonly [URL, string]>([
  ['/landing', [new URL('../../public/index.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/landing.css', [new URL('../../public/landing.css', import.meta.url), 'text/css; charset=utf-8']],
  ['/auth.css', [new URL('./auth.css', import.meta.url), 'text/css; charset=utf-8']],
]);
const assets = new Map<string, readonly [string, string]>([
  ['/workspace', ['index.html', 'text/html; charset=utf-8']],
  ['/learning.js', ['learning.js', 'text/javascript; charset=utf-8']],
  ['/learning.css', ['learning.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
] as const);
const DraftId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function dashboardData(db: Db, now = new Date(), hosted = false) {
  const since = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const jobs = db.prepare(`
    SELECT j.id, j.title, j.url, j.location, j.source, j.state, j.first_seen_at, j.description,
           c.name AS company, s.fit_score, s.reasoning, length(j.description) > 0 AS has_description
      FROM jobs j JOIN companies c ON c.id = j.company_id
      LEFT JOIN job_scores s ON s.job_id = j.id AND s.prompt_version =
        (SELECT max(prompt_version) FROM job_scores WHERE job_id = j.id)
     WHERE j.first_seen_at >= ? ORDER BY j.first_seen_at DESC, j.id DESC
  `).all(since).filter((row) => !internshipRecommendationExclusion({
    title: String(row.title), description: String(row.description ?? ''), location: String(row.location ?? ''),
  })).map(({ description: _description, ...row }) => row);
  const drafts = db.prepare(`
    SELECT o.id,o.job_id,j.title,j.state,c.name AS company,CASE WHEN o.sent_at IS NULL THEN COALESCE(o.recipient_override,k.email) ELSE k.email END AS email,
      CASE WHEN o.sent_at IS NULL THEN COALESCE(o.local_subject,o.subject) ELSE o.subject END AS subject,
      CASE WHEN o.sent_at IS NULL THEN COALESCE(o.local_body,o.body) ELSE o.body END AS body,o.drafted_at,o.approved_at,CASE WHEN o.approved_at IS NOT NULL THEN o.scheduled_send_at END AS scheduled_send_at,o.delete_requested_at,o.archived_at,
      o.sent_at,o.replied_at,o.bounced_at,o.follow_up_at,o.revision,o.edit_pending AS local_only,
      x.outcome,x.recorded_at AS outcome_at,o.application_id,aj.title AS application_title,aj.url AS application_url,
      k.dead_at IS NULL AS contact_active, (${MUTABLE}) AS editable,
      (o.sent_at IS NULL AND o.approved_at IS NULL AND o.gmail_draft_id IS NOT NULL
        AND (j.state IN ('DRAFTED','PENDING_APPROVAL') OR o.delete_requested_at IS NOT NULL)) AS deletable,
      CASE WHEN o.sent_at IS NOT NULL THEN 'Sent' WHEN o.archived_at IS NOT NULL OR j.state='REJECTED_BY_USER' THEN 'Archived'
        WHEN o.approved_at IS NOT NULL THEN 'Approved' ELSE 'Needs Review' END AS status
    FROM outreach o JOIN jobs j ON j.id=o.job_id JOIN companies c ON c.id=j.company_id JOIN contacts k ON k.id=o.contact_id
    LEFT JOIN outreach_outcomes x ON x.outreach_id=o.id LEFT JOIN applications a ON a.id=o.application_id LEFT JOIN jobs aj ON aj.id=a.job_id
    ORDER BY o.drafted_at DESC,o.id DESC
  `).all();
  const applications = db.prepare(`SELECT a.id,a.job_id,a.created_at,a.recipient,j.title,j.url,c.name AS company
    FROM applications a JOIN jobs j ON j.id=a.job_id JOIN companies c ON c.id=j.company_id ORDER BY c.name,j.title`).all();
  const learningSummary=db.prepare(`WITH latest AS (SELECT max(id) AS id FROM learning_plans GROUP BY application_id)
    SELECT (SELECT count(*) FROM latest) AS plans,
      count(*) FILTER(WHERE status='mastered') AS mastered,count(*) FILTER(WHERE status='revision') AS revision,
      (SELECT a.job_id FROM learning_plans p JOIN applications a ON a.id=p.application_id ORDER BY p.id DESC LIMIT 1) AS latest_job_id
    FROM learning_progress WHERE plan_id IN (SELECT id FROM latest)`).get();
  return { ...trackingData(db,now), jobs, drafts, applications, learningSummary, matchThreshold: MATCH_THRESHOLD, sendingArmed: !hosted && sendingArmed(), refreshedAt: now.toISOString() };
}

// Mirrors the manual Telegram approval path. Only launchd's existing sender contacts Gmail.
export function approveDraft(db: Db, id: number, revision = 0) {
  if (!sendingArmed()) return { status: 409, message: 'Sending is disarmed. Nothing was queued.' };
  const { changes } = db.prepare(`
    UPDATE outreach SET approved_at = ?
     WHERE id = ? AND revision = ? AND sent_at IS NULL AND approved_at IS NULL AND gmail_draft_id IS NOT NULL
       AND archived_at IS NULL AND edit_pending = 0 AND delete_requested_at IS NULL
       AND EXISTS (SELECT 1 FROM jobs WHERE id = outreach.job_id AND state = 'PENDING_APPROVAL')
       AND EXISTS (SELECT 1 FROM contacts WHERE id = outreach.contact_id AND dead_at IS NULL)
  `).run(nowIso(), id, revision);
  return changes === 1
    ? { status: 200, message: 'Approved and queued. The scheduled sender will handle delivery.' }
    : { status: 409, message: 'This draft is no longer eligible to queue. Refresh and review its status.' };
}

async function requestJson(req: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > 100_000) { chunks.length = 0; continue; }
    chunks.push(chunk);
  }
  if (!length) return {};
  if (length > 100_000 || req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Invalid JSON');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function dashboardServer(db: Db, port: number, config = dashboardConfig(port)) {
  const { host, origin, hosted } = config;
  const auth = config.hosted ? ownerAuth(db, config.setupDigest) : undefined;
  let replyCache: { expires: number; result: Awaited<ReturnType<typeof readReplies>> } | undefined;
  let inFlight: ReturnType<typeof readReplies> | undefined;
  return createServer({ requestTimeout: 30_000, headersTimeout: 10_000, connectionsCheckingInterval: 5_000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // `no-referrer` can send Origin: null on a browser form POST, including same-origin login.
    res.setHeader('Referrer-Policy', hosted ? 'same-origin' : 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (hosted) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.host !== host || (!hosted && (req.socket.remoteAddress !== '127.0.0.1' ||
      Object.keys(req.headers).some((key) => key === 'forwarded' || key.startsWith('x-forwarded-'))))) {
      return json(403, { message: hosted ? 'Use the configured dashboard address.' : 'Use the local dashboard link.' });
    }
    const path = req.url?.split('?', 1)[0] ?? '';
    const read = req.method === 'GET' || req.method === 'HEAD';
    const unavailable = () => json(503, { message: 'This feature is only available on the local dashboard.' });
    try {
      const publicAsset = read ? publicAssets.get(hosted && path === '/' ? '/landing' : path) : undefined;
      if (publicAsset) {
        const content = readFileSync(publicAsset[0]);
        res.writeHead(200, { 'Content-Type': publicAsset[1] });
        return res.end(content);
      }
      if (path === '/login' || path === '/signup') {
        if (read && !auth) return redirect(res, '/workspace');
        if (auth && (read || req.method === 'POST')) {
          if (!read && req.headers.origin !== origin) return json(403, { message: 'Use the dashboard to continue.' });
          return await auth.credentials(req, res, path === '/login' ? 'login' : 'signup');
        }
      }
      const session = auth?.session(req);
      if (path === '/api/auth/session' && read) {
        if (!auth) return json(200, { authenticated: true, local: true });
        if (!session) return json(401, { authenticated: false });
        return json(200, { authenticated: true, ...session });
      }
      if (auth && !session) {
        if (path === '/workspace' && read) return redirect(res, '/login');
        return json(401, { message: 'Log in to open the workspace.' });
      }
      // Every non-read hosted route is same-origin, including routes added later.
      if (hosted && !read && req.headers.origin !== origin) return json(403, { message: 'Use the dashboard to continue.' });
      if (auth && path === '/logout' && req.method === 'POST') return auth.logout(req, res);

      const prep = /^\/api\/interview-prep\/(\d+)$/.exec(path);
      if (req.method === 'GET' && prep) {
        const id = parseLearning(DraftId, prep[1]);
        const job = db.prepare(`SELECT j.title, j.url, substr(j.description,1,12000) AS description, c.name AS company,
          (SELECT id FROM applications WHERE job_id=j.id) AS application_id
          FROM jobs j JOIN companies c ON c.id=j.company_id WHERE j.id=?`).get(id);
        if (!job) return json(404,{message:'This posting is no longer saved.'});
        let projects: {name:string;summary:string}[] = [];
        if (!hosted) {
          try { projects=loadProfile(process.env.JOBAGENT_PROFILE).projects.map(({name,summary})=>({name,summary})); } catch { /* Profile is optional. */ }
        }
        return json(200,{...job,projects,modelConfigured:!hosted && !!process.env.JOBAGENT_OLLAMA_MODEL});
      }
      if (req.method === 'GET' && path === '/api/learning') return json(200,learningIndex(db, !hosted));
      const learn=/^\/api\/learning\/(\d+)(?:\/([a-z]+))?$/.exec(path);
      if (req.method==='GET' && learn && !learn[2]) return json(200,learningData(db,parseLearning(DraftId,learn[1])));
      const learnAction=path==='/api/learning/application'?'application':learn?.[2];
      if (req.method==='POST' && learnAction) {
        if(req.headers.origin!==origin||req.headers['x-jobagent-action']!==learnAction)return json(403,{message:'Use the local dashboard.'});
        if (hosted && (learnAction === 'generate' || learnAction === 'answer')) return unavailable();
        let input:unknown;
        try {input=await requestJson(req);} catch {return json(400,{message:'Invalid learning request.'});}
        if(learnAction==='application' && !learn)return json(200,addLearningApplication(db,parseLearning(learningInputs.application,input).jobId));
        try {return json(200,await learningAction(db,parseLearning(DraftId,learn?.[1]),learnAction,input));}
        catch(err) {
          if(err instanceof LearningError)throw err;
          if(learnAction==='generate'||learnAction==='answer')return json(503,{message:err instanceof Error?err.message:'The local model could not finish.'});
          throw err;
        }
      }
      if (req.method === 'GET' && path === '/api/dashboard') return json(200, dashboardData(db, new Date(), hosted));
      if (req.method === 'GET' && path === '/api/replies') {
        if (hosted) return unavailable();
        if (replyCache && replyCache.expires > Date.now()) return json(200, replyCache.result);
        try {
          inFlight ??= readReplies(db).finally(() => { inFlight = undefined; });
          const result = await inFlight;
          replyCache = { expires: Date.now() + (result.unavailable ? 15_000 : 60_000), result };
          return json(200, result);
        } catch { return json(502, { message: 'Could not check Gmail. Try again or check your Gmail connection.' }); }
      }
      const followup = /^\/api\/followups\/(\d+)$/.exec(path);
      if (req.method === 'POST' && followup) {
        if (req.headers.origin !== origin || req.headers['x-jobagent-action'] !== 'followup') return json(403,{message:'Use the local dashboard.'});
        const id = DraftId.safeParse(followup[1]);
        let input;
        try { input=FollowupChange.safeParse(await requestJson(req)); } catch { return json(400,{message:'Invalid data.'}); }
        if (!id.success || !input.success) return json(400,{message:'Check the follow-up details.'});
        const result=changeFollowup(db,id.data,input.data);
        return json(result.status,{message:result.message});
      }
      const action = /^\/api\/drafts\/(\d+)\/(send|delete|edit|quality|regenerate|application|archive|followup|outcome|review)$/.exec(path);
      if (req.method === 'POST' && action) {
        if (req.headers.origin !== origin || req.headers['x-jobagent-action'] !== action[2]) {
          return json(403, { message: 'This action must come from the local dashboard.' });
        }
        if (hosted && ['send', 'delete', 'review', 'quality'].includes(action[2]!)) return unavailable();
        const id = DraftId.safeParse(action[1]);
        if (!id.success) return json(400, { message: 'Invalid draft ID.' });
        const invalid = () => json(400, { message: 'Check the input and try again.' });
        let input: unknown = {};
        try { input = await requestJson(req); } catch { return invalid(); }
        const key = id.data;
        let result: {status:number;message:string};
        switch (action[2]) {
          case 'delete': result = await deleteDraft(db,key); break;
          case 'send': {
            const parsed = z.object({ revision: Revision, reviewed: z.literal(true) }).safeParse(input);
            if (!parsed.success) return invalid();
            result = approveDraft(db,key,parsed.data.revision); break;
          }
          case 'edit': {
            const parsed = EditDraft.safeParse(input);
            if (!parsed.success) return invalid();
            result = saveDraft(db,key,parsed.data); break;
          }
          case 'archive': {
            const parsed = z.object({archived:z.boolean()}).safeParse(input);
            if (!parsed.success) return invalid();
            result = archiveDraft(db,key,parsed.data.archived); break;
          }
          case 'followup': {
            const parsed=FollowupCreate.safeParse(input);
            if (!parsed.success) return invalid();
            result=createFollowup(db,key,parsed.data); break;
          }
          case 'outcome': {
            const parsed=z.object({outcome:Outcome.nullable()}).safeParse(input);
            if (!parsed.success) return invalid();
            result=setOutcome(db,key,parsed.data.outcome); break;
          }
          case 'application': {
            const parsed = ApplicationInput.safeParse(input);
            if (!parsed.success) return invalid();
            result = updateApplication(db,key,parsed.data); break;
          }
          case 'review': {
            const parsed=ReviewInput.safeParse(input);
            if (!parsed.success) return invalid();
            const reviewed=await localReview(db,key,parsed.data);
            return json(reviewed.status,reviewed);
          }
          case 'quality': {
            const parsed = z.object({email:z.string().max(254), subject:z.string().max(250), body:z.string().max(20_000)}).safeParse(input);
            if (!parsed.success) return invalid();
            if (!db.prepare('SELECT 1 FROM outreach WHERE id=?').get(key)) return json(404,{ message: 'Outreach record not found.' });
            const { assessDraft } = await import('./quality.ts');
            return json(200, await assessDraft(db,key,parsed.data));
          }
          default: {
            const proposal = regenerateDraft(db,key);
            return proposal ? json(200, proposal) : json(409, { message:'This draft cannot be regenerated.' });
          }
        }
        return json(result.status, { message: result.message });
      }
      const asset = read ? assets.get(!hosted && path === '/' ? '/workspace' : path) : undefined;
      if (!asset) return json(404, { message: 'Not found.' });
      const content = readFileSync(new URL(asset[0], import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(content);
    } catch (err) {
      if (err instanceof LearningError) return json(err.status,{message:err.message});
      console.error(err);
      json(500, { message: 'Could not read or update JobAgent. Check the dashboard server log.' });
    }
  });
}

if (import.meta.main) {
  const port = z.coerce.number().int().min(1).max(65535).parse(process.env['JOBAGENT_DASHBOARD_PORT'] ?? 4317);
  const config = dashboardConfig(port);
  if (config.hosted) process.umask(0o077); // New hosted database files and directories are private.
  const db = openDb(config.hosted ? hostedDbPath(process.env.JOBAGENT_DB) : DEFAULT_DB_PATH);
  dashboardServer(db, port, config).listen(port, config.bind, () => {
    console.log(`JobAgent dashboard: ${config.origin}`);
  });
}
