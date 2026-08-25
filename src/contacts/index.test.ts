/**
 * The stage, with the two network halves stubbed. What matters here is the bookkeeping:
 * which jobs advance, which retry, when a company is only visited once, and that nothing
 * downstream ever receives an unverified domain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../store/db.ts';
import { upsertCompany } from '../store/companies.ts';
import { upsertJob } from '../store/jobs.ts';
import { RawJob, nowIso } from '../store/schema.ts';
import { stateOf, transition, MAX_CONTACT_ATTEMPTS } from '../store/state.ts';
import type { StageContext } from '../stage.ts';
import { runContacts, pendingByCompany } from './index.ts';
import type { ContactCandidate } from './cascade.ts';

const context = (db: ReturnType<typeof openDb>) => {
  const counts: Record<string, number> = {};
  const logs: string[] = [];
  const faults: string[] = [];
  const ctx: StageContext = {
    db,
    dryRun: false,
    log: (m) => logs.push(m),
    count: (k, n = 1) => {
      counts[k] = (counts[k] ?? 0) + n;
    },
    fault: (m) => faults.push(m),
    signal: new AbortController().signal,
  };
  return { ctx, counts, logs, faults };
};

const candidate = (over: Partial<ContactCandidate> = {}): ContactCandidate => ({
  email: 'careers@acme.com',
  name: null,
  title: null,
  source: 'team_page',
  rank: 350,
  found_at: 'https://acme.com/careers',
  ...over,
});

/** A company with `n` matched jobs, all of them scored and matched. */
function seed(db: ReturnType<typeof openDb>, domain: string, titles: string[]) {
  const companyId = upsertCompany(db, { name: 'Acme', domain });
  const ids = titles.map((title, i) => {
    const job = upsertJob(
      db,
      companyId,
      RawJob.parse({
        company_name: 'Acme',
        company_domain: domain,
        source: 'gmail-alert',
        source_id: `alert-${i}`,
        url: `https://www.linkedin.com/jobs/view/${i}`,
        title,
        location: 'Bengaluru',
      }),
    );
    transition(db, job.id, 'DISCOVERED', 'SCORED');
    transition(db, job.id, 'SCORED', 'MATCHED');
    return job.id;
  });
  return { companyId, ids };
}

test('one contact serves every matched job at the company', async () => {
  const db = openDb(':memory:');
  const { ids } = seed(db, 'acme.com', ['Backend Intern', 'ML Intern']);
  const { ctx, counts } = context(db);

  let calls = 0;
  await runContacts(ctx, {
    findContacts: async () => {
      calls++;
      return [candidate()];
    },
    mxValid: async () => true,
  });

  // The cascade is the expensive part; running it per job would repeat identical work
  // (decision 005).
  assert.equal(calls, 1);
  assert.equal(counts['ready_to_draft'], 2);
  for (const id of ids) assert.equal(stateOf(db, id), 'DRAFTED');

  const contacts = db.prepare('SELECT email, confidence FROM contacts').all() as {
    email: string;
    confidence: string;
  }[];
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]!.email, 'careers@acme.com');
  assert.equal(contacts[0]!.confidence, 'high');
});

test('a pattern guess is stored as low confidence and can never auto-send', async () => {
  const db = openDb(':memory:');
  seed(db, 'acme.com', ['Backend Intern']);
  const { ctx } = context(db);

  await runContacts(ctx, {
    findContacts: async () => [candidate({ source: 'pattern', found_at: 'pattern' })],
    mxValid: async () => true,
  });

  const row = db.prepare('SELECT confidence, mx_valid FROM contacts').get() as {
    confidence: string;
    mx_valid: number;
  };
  assert.equal(row.confidence, 'low');
  assert.equal(row.mx_valid, 1);
});

test('a marker domain is resolved first, and the cascade sees the real one', async () => {
  const db = openDb(':memory:');
  seed(db, 'acme.unknown.invalid', ['Backend Intern']);
  const { ctx, counts } = context(db);

  let sawDomain = '';
  await runContacts(ctx, {
    discoverDomain: async () => ({ domain: 'acme.io', name: 'Acme', via: 'heuristic', proof: 'page' }),
    findContacts: async (company) => {
      sawDomain = company.domain;
      return [candidate({ email: 'careers@acme.io' })];
    },
    mxValid: async () => true,
  });

  assert.equal(sawDomain, 'acme.io', 'never hand the cascade an .invalid marker');
  assert.equal(counts['domain_resolved'], 1);
  const company = db.prepare('SELECT domain FROM companies').get() as { domain: string };
  assert.equal(company.domain, 'acme.io');
});

test('an unresolvable domain sends the job to NEEDS_CONTACT, not to a guessed address', async () => {
  const db = openDb(':memory:');
  const { ids } = seed(db, 'acme.unknown.invalid', ['Backend Intern']);
  const { ctx, counts } = context(db);

  let cascaded = false;
  await runContacts(ctx, {
    discoverDomain: async () => null,
    findContacts: async () => {
      cascaded = true;
      return [candidate()];
    },
  });

  assert.equal(cascaded, false, 'no domain means no cascade at all');
  assert.equal(counts['domain_unresolved'], 1);
  assert.equal(stateOf(db, ids[0]!), 'NEEDS_CONTACT');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts').get()!.n, 0);
});

test('a company that yields nothing retries three times, then expires', async () => {
  const db = openDb(':memory:');
  const { ids } = seed(db, 'acme.com', ['Backend Intern']);
  const jobId = ids[0]!;
  const nothing = { findContacts: async () => [] };

  for (let attempt = 1; attempt <= MAX_CONTACT_ATTEMPTS; attempt++) {
    const { ctx } = context(db);
    await runContacts(ctx, nothing);
    // Retries are 3 days apart; pretend the wait has passed.
    db.prepare('UPDATE jobs SET last_contact_attempt_at = ? WHERE id = ?').run(
      new Date(Date.now() - 4 * 86_400_000).toISOString(),
      jobId,
    );
  }

  assert.equal(stateOf(db, jobId), 'EXPIRED');
});

test('a job whose retry is not due yet is left alone', () => {
  const db = openDb(':memory:');
  const { ids } = seed(db, 'acme.com', ['Backend Intern']);
  transition(db, ids[0]!, 'MATCHED', 'NEEDS_CONTACT');
  db.prepare('UPDATE jobs SET contact_attempts = 1, last_contact_attempt_at = ? WHERE id = ?').run(
    nowIso(),
    ids[0]!,
  );

  const { ctx } = context(db);
  assert.deepEqual(pendingByCompany(ctx), []);
});

test('a company already on file skips the cascade entirely', async () => {
  const db = openDb(':memory:');
  const { companyId } = seed(db, 'acme.com', ['Backend Intern']);
  db.prepare(
    `INSERT INTO contacts (company_id, email, source, confidence, mx_valid, created_at)
     VALUES (?, 'hr@acme.com', 'team_page', 'high', 1, ?)`,
  ).run(companyId, nowIso());

  const { ctx, counts } = context(db);
  let calls = 0;
  await runContacts(ctx, {
    findContacts: async () => {
      calls++;
      return [];
    },
  });

  assert.equal(calls, 0, 'the cache is the whole point');
  assert.equal(counts['cached'], 1);
  assert.equal(counts['ready_to_draft'], 1);
});

test('a company that throws is recorded as a fault and leaves its jobs put', async () => {
  const db = openDb(':memory:');
  const { ids } = seed(db, 'acme.com', ['Backend Intern']);
  const { ctx, faults } = context(db);

  await runContacts(ctx, {
    findContacts: async () => {
      throw new Error('site is on fire');
    },
  });

  // A fault rather than a log line: a company failing every morning is what the health
  // check exists to surface (decision 026).
  assert.equal(faults.length, 1);
  assert.match(faults[0]!, /site is on fire/);
  assert.equal(stateOf(db, ids[0]!), 'MATCHED', 'retried tomorrow, unchanged');
});

test('rerunning the stage is a no-op', async () => {
  const db = openDb(':memory:');
  seed(db, 'acme.com', ['Backend Intern']);
  const deps = { findContacts: async () => [candidate()], mxValid: async () => true };

  const first = context(db);
  await runContacts(first.ctx, deps);
  const second = context(db);
  await runContacts(second.ctx, deps);

  // Invariant 4: running the pipeline twice must change nothing the second time.
  assert.equal(second.counts['ready_to_draft'], undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts').get()!.n, 1);
});
