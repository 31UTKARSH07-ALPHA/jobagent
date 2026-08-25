/**
 * The stage, with Groq and Gmail both stubbed. What matters here is that a job gets exactly
 * one draft, ever, and that a failure anywhere leaves the job retryable rather than half-done.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../store/db.ts';
import { upsertCompany } from '../store/companies.ts';
import { upsertJob } from '../store/jobs.ts';
import { insertScore } from '../store/scores.ts';
import { RawJob, nowIso, type Profile } from '../store/schema.ts';
import { transition } from '../store/state.ts';
import type { StageContext } from '../stage.ts';
import { runDraft, draftableJobs, MAX_DRAFTS_PER_RUN } from './index.ts';
import type { Drafter } from './compose.ts';
import type { DraftWriter } from './gmail-draft.ts';

const profile = {
  name: 'Utkarsh Pathak',
  email: 'u@example.com',
  phone: '',
  links: [],
  education: [],
  summary: 'Builds retrieval and backend systems.',
  skills: [],
  domains: [],
  projects: [],
  experience: [],
  achievements: [],
  target_roles: [],
  extracted_at: nowIso(),
  model: 'test',
} satisfies Profile;

const context = (db: ReturnType<typeof openDb>, dryRun = false) => {
  const counts: Record<string, number> = {};
  const faults: string[] = [];
  const ctx: StageContext = {
    db,
    dryRun,
    log: () => {},
    count: (k, n = 1) => {
      counts[k] = (counts[k] ?? 0) + n;
    },
    fault: (m) => faults.push(m),
    signal: new AbortController().signal,
  };
  return { ctx, counts, faults };
};

const drafter: Drafter = {
  model: 'test-model',
  compose: async (job) => ({ subject: `About ${job.title}`, body: 'Hi Acme.\n\nUtkarsh Pathak' }),
};

const writer = (): { calls: { to: string }[]; write: DraftWriter } => {
  const calls: { to: string }[] = [];
  return {
    calls,
    write: async (draft) => {
      calls.push({ to: draft.to });
      return { draftId: `draft-${calls.length}`, messageId: `msg-${calls.length}`, threadId: 't1' };
    },
  };
};

/** A job that has a verified contact and is sitting in DRAFTED, ready to be written about. */
function ready(
  db: ReturnType<typeof openDb>,
  opts: { title?: string; fit?: number; company?: string; contact?: boolean } = {},
): number {
  const company = opts.company ?? 'Acme';
  const domain = `${company.toLowerCase()}.com`;
  const companyId = upsertCompany(db, { name: company, domain });
  const { id } = upsertJob(
    db,
    companyId,
    RawJob.parse({
      company_name: company,
      company_domain: domain,
      source: 'greenhouse',
      url: `https://${domain}/jobs/${opts.title ?? 'x'}`,
      title: opts.title ?? 'Backend Intern',
      location: 'Bengaluru',
    }),
  );
  insertScore(
    db,
    id,
    4,
    opts.fit ?? 90,
    { level_fit: 9, location_fit: 9, stack_fit: 8, domain_fit: 8, reasoning: 'why', hook: 'a hook' },
    'test',
  );
  transition(db, id, 'DISCOVERED', 'SCORED');
  transition(db, id, 'SCORED', 'MATCHED');
  transition(db, id, 'MATCHED', 'DRAFTED');

  if (opts.contact !== false) {
    // One contact per company, however many roles are open there (decision 005).
    db.prepare(
      `INSERT INTO contacts (company_id, email, source, confidence, mx_valid, created_at)
       VALUES (?, ?, 'team_page', 'high', 1, ?)
       ON CONFLICT(email) DO NOTHING`,
    ).run(companyId, `careers@${domain}`, nowIso());
  }
  return id;
}

test('a drafted job becomes one Gmail draft and one outreach row', async () => {
  const db = openDb(':memory:');
  const jobId = ready(db);
  const gmail = writer();
  const { ctx, counts } = context(db);

  await runDraft(ctx, { drafter, writeDraft: gmail.write, profile });

  assert.equal(counts['drafted'], 1);
  assert.deepEqual(gmail.calls, [{ to: 'careers@acme.com' }]);

  const row = db.prepare('SELECT * FROM outreach WHERE job_id = ?').get(jobId) as {
    gmail_draft_id: string;
    subject: string;
    sent_at: string | null;
  };
  assert.equal(row.gmail_draft_id, 'draft-1');
  assert.equal(row.subject, 'About Backend Intern');
  assert.equal(row.sent_at, null, 'phase 2 never sends');
});

test('running twice writes one draft, not two', async () => {
  const db = openDb(':memory:');
  ready(db);
  const gmail = writer();
  const deps = { drafter, writeDraft: gmail.write, profile };

  await runDraft(context(db).ctx, deps);
  const second = context(db);
  await runDraft(second.ctx, deps);

  // Invariant 2 and 4 together: UNIQUE(job_id) makes a second draft impossible, and the
  // stage must not even try.
  assert.equal(gmail.calls.length, 1);
  assert.equal(second.counts['drafted'], undefined);
});

test('a job whose company has no contact is not drafted', () => {
  const db = openDb(':memory:');
  ready(db, { contact: false });
  assert.deepEqual(draftableJobs(context(db).ctx), []);
});

test('a contact whose domain failed the MX check is not written to', () => {
  const db = openDb(':memory:');
  ready(db);
  db.prepare('UPDATE contacts SET mx_valid = 0').run();
  assert.deepEqual(draftableJobs(context(db).ctx), []);
});

test('a Gmail failure leaves no row, so tomorrow retries', async () => {
  const db = openDb(':memory:');
  const jobId = ready(db);
  const { ctx, faults } = context(db);

  await runDraft(ctx, {
    drafter,
    profile,
    writeDraft: async () => {
      throw new Error('Gmail said no');
    },
  });

  // The draft is created before the row is written precisely so this case is clean: a row
  // claiming a draft that does not exist would be blocked from ever retrying by UNIQUE(job_id).
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outreach').get()!.n, 0);
  assert.equal(faults.length, 1);

  const gmail = writer();
  await runDraft(context(db).ctx, { drafter, writeDraft: gmail.write, profile });
  assert.equal(gmail.calls.length, 1, 'retried the next run');
  assert.equal(db.prepare('SELECT job_id FROM outreach').get()!.job_id, jobId);
});

test('a dry run writes nothing anywhere', async () => {
  const db = openDb(':memory:');
  ready(db);
  const gmail = writer();
  const { ctx, counts } = context(db, true);

  await runDraft(ctx, { drafter, writeDraft: gmail.write, profile });

  assert.equal(counts['would_draft'], 1);
  assert.equal(gmail.calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outreach').get()!.n, 0);
});

test('the best-scoring jobs are drafted first, and the rest wait', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < MAX_DRAFTS_PER_RUN + 3; i++) {
    ready(db, { title: `Intern ${i}`, fit: 70 + i, company: `Co${i}` });
  }

  const picked = draftableJobs(context(db).ctx);
  assert.equal(picked.length, MAX_DRAFTS_PER_RUN);
  const scores = picked.map((p) => p.score.fit_score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'best first');
  assert.equal(scores[0], 70 + MAX_DRAFTS_PER_RUN + 2);
});

test('two roles at one company each get their own draft to the same contact', async () => {
  const db = openDb(':memory:');
  ready(db, { title: 'Backend Intern' });
  ready(db, { title: 'ML Intern' });
  const gmail = writer();

  await runDraft(context(db).ctx, { drafter, writeDraft: gmail.write, profile });

  assert.equal(gmail.calls.length, 2);
  assert.deepEqual(gmail.calls.map((c) => c.to), ['careers@acme.com', 'careers@acme.com']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outreach').get()!.n, 2);
});
