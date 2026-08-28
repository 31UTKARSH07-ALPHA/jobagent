/**
 * The instant alert. What matters is that it stays rare, that it cannot fire for a posting
 * nobody has read, and that a job it reports never appears in the morning digest as well.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../store/db.ts';
import { upsertCompany } from '../store/companies.ts';
import { upsertJob } from '../store/jobs.ts';
import { insertScore } from '../store/scores.ts';
import { pendingDigestItems } from '../store/digest.ts';
import { transition } from '../store/state.ts';
import { RawJob, type ScoreResult } from '../store/schema.ts';
import { PROMPT_VERSION, TITLE_ONLY_CEILING } from '../match/score.ts';
import type { StageContext } from '../stage.ts';
import { runAlert, ALERT_THRESHOLD, MAX_ALERTS_PER_RUN } from './alert.ts';
import { runDigest } from './digest.ts';

const config = { token: 't', chatId: '1' };

function context(db: Db, dryRun = false): StageContext & { counts: Record<string, number>; logs: string[] } {
  const counts: Record<string, number> = {};
  const logs: string[] = [];
  return {
    db,
    counts,
    logs,
    dryRun,
    signal: new AbortController().signal,
    fault: () => {},
    log: (m) => logs.push(m),
    count: (key, n = 1) => {
      counts[key] = (counts[key] ?? 0) + n;
    },
  };
}

const judgement = (): ScoreResult => ({
  level_fit: 9,
  location_fit: 9,
  stack_fit: 9,
  domain_fit: 9,
  reasoning: 'strong on every factor',
  hook: 'I built a typeahead engine at p95 8 ms.',
});

function seed(db: Db, opts: { fit: number; title?: string; company?: string }): number {
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
      description: 'A real posting with a real description.',
    }),
  );
  insertScore(db, id, PROMPT_VERSION, opts.fit, judgement(), 'test');
  transition(db, id, 'DISCOVERED', 'SCORED');
  transition(db, id, 'SCORED', 'MATCHED');
  return id;
}

const fakeSend = () => {
  const calls: string[] = [];
  return { calls, send: async (_c: unknown, text: string) => void calls.push(text) };
};

test('a strong match is alerted immediately', async () => {
  const db = openDb(':memory:');
  seed(db, { fit: 92, title: 'Software Engineer Intern' });
  const sent = fakeSend();
  const ctx = context(db);

  await runAlert(ctx, { send: sent.send, config });

  assert.equal(sent.calls.length, 1);
  assert.match(sent.calls[0]!, /Strong match just in/);
  assert.equal(ctx.counts['alerted'], 1);
});

test('an ordinary match waits for the morning digest', async () => {
  const db = openDb(':memory:');
  seed(db, { fit: ALERT_THRESHOLD - 1 });
  const sent = fakeSend();

  await runAlert(context(db), { send: sent.send, config });

  // Silence is the normal case. A ping that fires hourly is a ping you learn to swipe away.
  assert.equal(sent.calls.length, 0);
  assert.equal(pendingDigestItems(db).length, 1, 'still reported at 06:00');
});

test('a posting with no description can never trigger an alert', async () => {
  // Decision 023 caps title-only scores at 84, one below the bar — so an alert always means
  // a posting whose full text was actually read.
  assert.ok(TITLE_ONLY_CEILING < ALERT_THRESHOLD);
});

test('an alerted job is not repeated by the digest', async () => {
  const db = openDb(':memory:');
  seed(db, { fit: 95 });
  const alerts = fakeSend();
  const digests = fakeSend();

  await runAlert(context(db), { send: alerts.send, config });
  await runDigest(context(db), { send: digests.send, config });

  assert.equal(alerts.calls.length, 1);
  assert.equal(digests.calls.length, 0, 'one job, one message, whichever gets there first');
});

test('a burst is capped and the rest fall through to the digest', async () => {
  const db = openDb(':memory:');
  for (let i = 0; i < MAX_ALERTS_PER_RUN + 2; i++) {
    seed(db, { fit: 90 + i, title: `Intern ${i}`, company: `Co${i}` });
  }
  const sent = fakeSend();
  const ctx = context(db);

  await runAlert(ctx, { send: sent.send, config });

  assert.equal(ctx.counts['alerted'], MAX_ALERTS_PER_RUN);
  assert.equal(pendingDigestItems(db).length, 2, 'the remainder is a backlog, which is the digest');
});

test('a dry run sends nothing and marks nothing', async () => {
  const db = openDb(':memory:');
  seed(db, { fit: 95 });
  const sent = fakeSend();
  const ctx = context(db, true);

  await runAlert(ctx, { send: sent.send, config });

  assert.equal(sent.calls.length, 0);
  assert.equal(ctx.counts['would_alert'], 1);
  assert.equal(pendingDigestItems(db).length, 1);
});

test('a failed send leaves the job for the digest rather than losing it', async () => {
  const db = openDb(':memory:');
  seed(db, { fit: 95 });

  await assert.rejects(
    runAlert(context(db), {
      config,
      send: async () => {
        throw new Error('telegram is down');
      },
    }),
  );

  assert.equal(pendingDigestItems(db).length, 1);
});
