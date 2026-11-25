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
import { transition, stateOf } from '../store/state.ts';
import type { StageContext } from '../stage.ts';
import { runDraft, draftableJobs, expireUnactionable, MAX_DRAFTS_PER_RUN } from './index.ts';
import { isUnpaid } from '../ingest/filter.ts';
import { PROMPT_VERSION } from '../match/score.ts';
import { RAMP } from '../send/gate.ts';
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
  opts: { title?: string; fit?: number; company?: string; contact?: boolean; version?: number } = {},
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
    // PROMPT_VERSION, not a literal: pinned at 4 while the scorer was on 5, every job this
    // helper built looked to `expireUnactionable` like one awaiting a re-score.
    opts.version ?? PROMPT_VERSION,
    opts.fit ?? 90,
    { level_fit: 9, location_fit: 9, stack_fit: 8, domain_fit: 8, employer_fit: 8,
      reasoning: 'why', hook: 'a hook' },
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

test('a guessed address is not drafted while the policy is trusted-only', () => {
  // His call, 2026-08-28: published addresses first, guesses only once there is evidence.
  // Gated at drafting rather than sending because the drafts are his review queue.
  const db = openDb(':memory:');
  ready(db);
  db.prepare("UPDATE contacts SET source = 'pattern', confidence = 'low'").run();
  assert.deepEqual(draftableJobs(context(db).ctx), []);
});

test('a job the current rubric would reject is not drafted', () => {
  // A rubric change leaves jobs in a live state that the new scores reject, and there is no
  // edge back out of MATCHED. The v5 re-score left six DRAFTED jobs scoring 47-65 against a
  // threshold of 70 — and drafting them means emailing about them.
  const db = openDb(':memory:');
  const job = ready(db, { fit: 90 });
  db.prepare(
    `INSERT INTO job_scores (job_id, prompt_version, fit_score, level_fit, location_fit,
                             stack_fit, domain_fit, reasoning, hook, model, scored_at)
     VALUES (?, ${PROMPT_VERSION + 1}, 47, 3, 10, 3, 3, 'the tighter rubric disagrees', 'hook', 'test', ?)`,
  ).run(job, nowIso());

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

  const picked = draftableJobs(context(db).ctx, MAX_DRAFTS_PER_RUN);
  assert.equal(picked.length, MAX_DRAFTS_PER_RUN);
  const scores = picked.map((p) => p.score.fit_score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'best first');
  assert.equal(scores[0], 70 + MAX_DRAFTS_PER_RUN + 2);
});

test('drafting is capped by the send ramp, not by the reading limit', () => {
  // Nothing sent yet means week one, which is three a day. Drafting eight would queue five
  // he cannot send and has to scroll past (decision 038).
  const db = openDb(':memory:');
  for (let i = 0; i < MAX_DRAFTS_PER_RUN + 3; i++) {
    ready(db, { title: `Intern ${i}`, fit: 70 + i, company: `Co${i}` });
  }

  assert.equal(draftableJobs(context(db).ctx).length, RAMP[0]);
});

test('a second role at the same company is skipped, not queued', async () => {
  // His call, 2026-08-29: two cold emails from one student in the same week is how a small
  // company forms an opinion. The higher-scoring role is the one that survives.
  const db = openDb(':memory:');
  ready(db, { title: 'Backend Intern', fit: 88 });
  ready(db, { title: 'ML Intern', fit: 95 });
  const gmail = writer();
  const { ctx } = context(db);

  await runDraft(ctx, { drafter, writeDraft: gmail.write, profile });

  // The sibling is dropped during selection rather than skipped mid-draft, so its slot goes to
  // another company instead of being lost — hence no `suppressed_sibling` here any more.
  assert.equal(gmail.calls.length, 1);
  const written = db.prepare('SELECT subject FROM outreach').get() as { subject: string };
  assert.match(written.subject, /ML Intern/, 'the better-scoring role is the one written to');
});

test('suppression lifts when the first email bounced', () => {
  // A bounced email never arrived, so the company was never really contacted. Suppression is
  // a fact about now, which is why it is not a job state.
  const db = openDb(':memory:');
  const first = ready(db, { title: 'Backend Intern', fit: 88 });
  ready(db, { title: 'ML Intern', fit: 80 });
  db.prepare(
    `INSERT INTO outreach (job_id, contact_id, subject, body, drafted_at, sent_at)
     VALUES (?, 1, 's', 'b', ?, ?)`,
  ).run(first, nowIso(), nowIso());

  assert.equal(draftableJobs(context(db).ctx).length, 0, 'sibling suppressed while it stands');

  db.prepare('UPDATE outreach SET bounced_at = ? WHERE job_id = ?').run(nowIso(), first);
  assert.equal(draftableJobs(context(db).ctx).length, 1, 'and eligible again once it bounced');
});

test('an address a send proved wrong is never written to again', () => {
  const db = openDb(':memory:');
  ready(db);
  db.prepare("UPDATE contacts SET dead_at = ?, dead_reason = 'unknown-mailbox'").run(nowIso());

  // MX still says yes and always will — acme.com takes mail, the mailbox just does not exist.
  // Only the bounce knows (decision 047).
  assert.deepEqual(draftableJobs(context(db).ctx), []);
});

test('a company with a dead address and a live one uses the live one', () => {
  const db = openDb(':memory:');
  const jobId = ready(db);
  const companyId = (db.prepare('SELECT company_id AS id FROM jobs WHERE id = ?').get(jobId) as { id: number }).id;
  db.prepare("UPDATE contacts SET dead_at = ?, dead_reason = 'unknown-mailbox'").run(nowIso());
  db.prepare(
    `INSERT INTO contacts (company_id, email, source, confidence, mx_valid, created_at)
     VALUES (?, 'hr@acme.com', 'team_page', 'high', 1, ?)`,
  ).run(companyId, nowIso());

  // Retiring an address is the first time a company can have two contact rows, which is what
  // makes the choice between them worth pinning down rather than leaving to the query planner.
  const [row] = draftableJobs(context(db).ctx);
  assert.equal(row?.email, 'hr@acme.com');
});

test('a dry run previews what a real run would do, siblings included', async () => {
  const db = openDb(':memory:');
  ready(db, { title: 'Backend Intern', fit: 88 });
  ready(db, { title: 'ML Intern', fit: 95 });
  const gmail = writer();
  const { ctx, counts } = context(db, true);

  await runDraft(ctx, { drafter, writeDraft: gmail.write, profile });

  // A real run writes one of these two (038), so a preview saying "would draft" twice is a
  // number that gets believed.
  assert.equal(counts['would_draft'], 1);
  assert.equal(gmail.calls.length, 0, 'still writes nothing');
});

test('a posting that says it does not pay is never written to', () => {
  // The digest has held these back since 027; the draft stage did not, and two were sitting in
  // DRAFTED at 84 with live addresses on 2026-09-08 — one of them `high` confidence, i.e. one
  // flip of 048 away from sending itself. The more consequential stage had the weaker guard.
  const db = openDb(':memory:');
  ready(db, { title: '6-Month Unpaid Internship — Forward-Deployed Engineer' });
  ready(db, { title: 'Frontend Web Developer Antigravity Intern- NON PAID', company: 'Rp' });

  assert.deepEqual(draftableJobs(context(db).ctx), []);
});

test('an unpaid posting does not cost the day one of its drafts', () => {
  // The filter runs in JS so `isUnpaid` stays the one definition (SQLite has no REGEXP). That
  // makes the order load-bearing: `LIMIT cap` then filter would draft two on a three-a-day
  // ramp and look like the ramp working.
  const db = openDb(':memory:');
  ready(db, { title: 'Unpaid Backend Intern', company: 'Nopay', fit: 99 });
  for (const c of ['Alpha', 'Beta', 'Gamma']) ready(db, { company: c, fit: 90 });

  const picked = draftableJobs(context(db).ctx, 3);
  assert.equal(picked.length, 3, 'the unpaid row is replaced, not merely dropped');
  assert.equal(
    picked.some((p) => isUnpaid(p.job.title)),
    false,
  );
});

test('a job the current rubric rejects is retired, not left in DRAFTED for ever', () => {
  // Six sat here after the v5 re-score moved under them (045): refused by the draft stage on
  // every run, counted in every backlog number, with no edge out of the state.
  const db = openDb(':memory:');
  const job = ready(db, { title: 'G - Trainee engineer', fit: 47 });
  const { ctx, counts } = context(db);

  expireUnactionable(ctx);

  assert.equal(stateOf(db, job), 'EXPIRED');
  assert.equal(counts['expired_below_threshold'], 1);
});

test('a stale score is left alone, because the next re-score may rescue it', () => {
  // EXPIRED is terminal and a rubric bump moves scores a long way — CoinDCX went 47 to 84
  // between v4 and v5 (046). Expiring on an opinion the re-score is about to replace is
  // decision 041 with the consequences pointing the other way.
  const db = openDb(':memory:');
  const job = ready(db, { title: 'Backend Intern', fit: 47, version: PROMPT_VERSION - 1 });

  expireUnactionable(context(db).ctx);

  assert.equal(stateOf(db, job), 'DRAFTED', 'waits for the re-score to reach it');
});

test('an unpaid posting is retired whatever it scored', () => {
  const db = openDb(':memory:');
  const job = ready(db, { title: '6-Month Unpaid Internship — Forward-Deployed Engineer', fit: 84 });
  const { ctx, counts } = context(db);

  expireUnactionable(ctx);

  // Permanent: no rubric bump changes what the title says about money.
  assert.equal(stateOf(db, job), 'EXPIRED');
  assert.equal(counts['expired_unpaid'], 1);
});

test('a job with a draft already written is never retired by the sweep', () => {
  // Something is written and possibly sent. That is the gate's business, not this sweep's.
  const db = openDb(':memory:');
  const job = ready(db, { title: 'Backend Intern', fit: 47 });
  db.prepare(
    `INSERT INTO outreach (job_id, contact_id, subject, body, gmail_draft_id, drafted_at)
     VALUES (?, 1, 's', 'b', 'draft-1', ?)`,
  ).run(job, nowIso());

  expireUnactionable(context(db).ctx);

  assert.equal(stateOf(db, job), 'DRAFTED');
});

test('a matching job is not swept away', () => {
  const db = openDb(':memory:');
  const job = ready(db, { fit: 90 });
  expireUnactionable(context(db).ctx);
  assert.equal(stateOf(db, job), 'DRAFTED');
});

test('a dry run reports what it would retire and retires nothing', () => {
  // EXPIRED is terminal with no path back. `dryRun` normally permits DB writes — ingest and
  // scoring both write on one — but a transition needing a hand-edit to undo is the exception.
  const db = openDb(':memory:');
  const job = ready(db, { title: 'G - Trainee engineer', fit: 47 });
  const { ctx, counts } = context(db, true);

  expireUnactionable(ctx);

  assert.equal(stateOf(db, job), 'DRAFTED');
  assert.equal(counts['would_expire'], 1);
});

test('two roles at one company do not cost the day a draft', () => {
  // The sibling rule (038) used to be applied downstream of `LIMIT cap`, so a company holding
  // two of the top three slots produced two drafts instead of three. Measured on live data on
  // 2026-09-08: 8byte took two slots and the run drafted 2 of 3.
  const db = openDb(':memory:');
  ready(db, { title: 'Backend Intern', company: 'Twinrole', fit: 99 });
  ready(db, { title: 'ML Intern', company: 'Twinrole', fit: 98 });
  for (const c of ['Alpha', 'Beta']) ready(db, { company: c, fit: 90 });

  const picked = draftableJobs(context(db).ctx, 3);

  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((p) => p.companyId)).size, 3, 'three distinct companies');
  // And the better-scoring of the two roles is the one that survived.
  assert.match(picked.find((p) => p.company === 'Twinrole')!.job.title, /Backend/);
});
