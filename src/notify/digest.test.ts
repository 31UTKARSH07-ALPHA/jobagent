/**
 * No network and no bot token. The send function is injected, so what is under test is the
 * part that matters: a job is reported exactly once, and the markup Telegram receives is
 * valid however hostile the job title is.
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
import type { StageContext } from '../stage.ts';
import { PROMPT_VERSION } from '../match/score.ts';
import { chunk, escapeHtml, MAX_MESSAGE_CHARS } from './telegram.ts';
import { MAX_ITEMS_PER_DIGEST, formatDigest, runDigest } from './digest.ts';

const CONFIG = { token: 'test-token', chatId: '123' };

const judgement = (over: Partial<ScoreResult> = {}): ScoreResult => ({
  level_fit: 10,
  location_fit: 10,
  stack_fit: 8,
  domain_fit: 7,
  reasoning: 'Overlaps on retrieval work.',
  hook: 'p95 8ms over 2M documents',
  ...over,
});

function context(db: Db, dryRun = false): StageContext & { counts: Record<string, number>; logs: string[] } {
  const counts: Record<string, number> = {};
  const logs: string[] = [];
  return {
    db,
    counts,
    logs,
    dryRun,
    log: (m) => logs.push(m),
    count: (key, n = 1) => {
      counts[key] = (counts[key] ?? 0) + n;
    },
  };
}

/** A MATCHED job with a score under the current rubric — what the digest looks for. */
function seedMatch(
  db: Db,
  opts: { title?: string; fit?: number; company?: string; location?: string } = {},
): number {
  const company = opts.company ?? 'Acme';
  const companyId = upsertCompany(db, { name: company, domain: `${company.toLowerCase()}.com` });
  const { id } = upsertJob(
    db,
    companyId,
    RawJob.parse({
      company_name: company,
      company_domain: `${company.toLowerCase()}.com`,
      source: 'greenhouse',
      url: `https://${company.toLowerCase()}.com/jobs/${opts.title ?? 'x'}`,
      title: opts.title ?? 'Backend Intern',
      location: opts.location ?? 'Bengaluru, India',
    }),
  );
  insertScore(db, id, PROMPT_VERSION, opts.fit ?? 90, judgement(), 'test-model');
  transition(db, id, 'DISCOVERED', 'SCORED');
  transition(db, id, 'SCORED', 'MATCHED');
  return id;
}

/** Captures what would have been sent. */
function fakeSend(): { calls: string[]; send: (c: unknown, text: string) => Promise<void> } {
  const calls: string[] = [];
  return {
    calls,
    send: async (_c, text) => {
      calls.push(text);
    },
  };
}

test('the digest reports best first', () => {
  const db = openDb(':memory:');
  seedMatch(db, { title: 'Middling Intern', fit: 74 });
  seedMatch(db, { title: 'Great Intern', fit: 97 });
  seedMatch(db, { title: 'Good Intern', fit: 88 });

  const items = pendingDigestItems(db);
  assert.deepEqual(
    items.map((i) => i.score.fit_score),
    [97, 88, 74],
  );
  assert.equal(items[0]?.job.title, 'Great Intern');
  assert.equal(items[0]?.company, 'Acme', 'the company name, never a bare domain');
  db.close();
});

test('rejected jobs never appear, and a rubric bump never hides a match', () => {
  const db = openDb(':memory:');
  const matched = seedMatch(db);

  // Scored, rejected — must never appear.
  const companyId = upsertCompany(db, { name: 'Acme', domain: 'acme.com' });
  const { id: rejected } = upsertJob(
    db,
    companyId,
    RawJob.parse({
      company_name: 'Acme',
      company_domain: 'acme.com',
      source: 'greenhouse',
      url: 'https://acme.com/jobs/no',
      title: 'Senior Engineer',
    }),
  );
  insertScore(db, rejected, PROMPT_VERSION, 20, judgement({ level_fit: 0 }), 'test-model');
  transition(db, rejected, 'DISCOVERED', 'SCORED');
  transition(db, rejected, 'SCORED', 'REJECTED');

  // Matched under an older rubric and not yet reported. Pinning the current prompt_version
  // used to drop this job from the digest permanently — it must still appear.
  const { id: stale } = upsertJob(
    db,
    companyId,
    RawJob.parse({
      company_name: 'Acme',
      company_domain: 'acme.com',
      source: 'greenhouse',
      url: 'https://acme.com/jobs/old',
      title: 'Old Rubric Intern',
    }),
  );
  insertScore(db, stale, PROMPT_VERSION - 1, 90, judgement(), 'test-model');
  transition(db, stale, 'DISCOVERED', 'SCORED');
  transition(db, stale, 'SCORED', 'MATCHED');

  const ids = pendingDigestItems(db).map((i) => i.job.id);
  assert.deepEqual(ids.sort(), [matched, stale].sort(), 'the rejected one is absent, the older-rubric one is not');
  db.close();
});

test('a re-scored job is reported once, with its newest score', () => {
  const db = openDb(':memory:');
  const id = seedMatch(db, { fit: 90 });
  // A rubric bump re-scores it lower. The digest must not show the job twice, and must quote
  // the new number.
  insertScore(db, id, PROMPT_VERSION + 1, 62, judgement({ stack_fit: 3 }), 'test-model');

  const items = pendingDigestItems(db);
  assert.equal(items.length, 1, 'one row per job, not one per score');
  assert.equal(items[0]?.score.fit_score, 62);
  db.close();
});

test('a job is reported exactly once, however often the stage runs', async () => {
  const db = openDb(':memory:');
  seedMatch(db, { title: 'Backend Intern' });
  const { calls, send } = fakeSend();

  const first = context(db);
  await runDigest(first, { send, config: CONFIG });
  assert.equal(calls.length, 1);
  assert.equal(first.counts['reported'], 1);

  const second = context(db);
  await runDigest(second, { send, config: CONFIG });
  assert.equal(calls.length, 1, 'the second run sends nothing');
  assert.equal(second.counts['reported'], undefined);
  assert.match(second.logs.join(), /no new matches/);
  db.close();
});

test('a failed send leaves everything unreported, so tomorrow retries it', async () => {
  const db = openDb(':memory:');
  seedMatch(db);

  const ctx = context(db);
  await assert.rejects(
    () =>
      runDigest(ctx, {
        config: CONFIG,
        send: () => Promise.reject(new Error('telegram 502: bad gateway')),
      }),
    /502/,
  );

  assert.equal(pendingDigestItems(db).length, 1, 'still pending');

  // And the retry works.
  const { calls, send } = fakeSend();
  await runDigest(context(db), { send, config: CONFIG });
  assert.equal(calls.length, 1);
  db.close();
});

test('a dry run prints without sending and without marking anything', async () => {
  const db = openDb(':memory:');
  seedMatch(db);
  const { calls, send } = fakeSend();

  const ctx = context(db, true);
  await runDigest(ctx, { send, config: CONFIG });

  assert.equal(calls.length, 0, 'nothing sent');
  assert.equal(ctx.counts['would_send'], 1);
  assert.equal(pendingDigestItems(db).length, 1, 'nothing marked');
  db.close();
});

test('an over-long day holds the remainder over instead of dropping it', async () => {
  const db = openDb(':memory:');
  const total = MAX_ITEMS_PER_DIGEST + 2;
  for (let i = 0; i < total; i++) seedMatch(db, { title: `Intern ${i}`, fit: 70 + i });

  const { calls, send } = fakeSend();
  const ctx = context(db);
  await runDigest(ctx, { send, config: CONFIG });

  assert.equal(ctx.counts['reported'], MAX_ITEMS_PER_DIGEST);
  assert.match(calls[0]!, /2 more waiting/);
  assert.equal(pendingDigestItems(db).length, 2);

  // The held-over two arrive next time — and they are the lowest scorers, since the digest
  // sends the best first.
  await runDigest(context(db), { send, config: CONFIG });
  assert.equal(pendingDigestItems(db).length, 0);
  db.close();
});

test('a missing token is a note, not a crash — the matches simply wait', async () => {
  const db = openDb(':memory:');
  seedMatch(db);

  const saved = { token: process.env['TELEGRAM_BOT_TOKEN'], chat: process.env['TELEGRAM_CHAT_ID'] };
  delete process.env['TELEGRAM_BOT_TOKEN'];
  delete process.env['TELEGRAM_CHAT_ID'];
  const ctx = context(db);
  try {
    await runDigest(ctx, { send: fakeSend().send });
  } finally {
    if (saved.token !== undefined) process.env['TELEGRAM_BOT_TOKEN'] = saved.token;
    if (saved.chat !== undefined) process.env['TELEGRAM_CHAT_ID'] = saved.chat;
  }

  assert.match(ctx.logs.join(), /BotFather/, 'the log says how to fix it');
  assert.equal(pendingDigestItems(db).length, 1, 'still pending');
  db.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Markup — a 400 from Telegram at 06:05 means no digest at all
// ─────────────────────────────────────────────────────────────────────────────

test('a hostile job title cannot break the markup', () => {
  const db = openDb(':memory:');
  seedMatch(db, { title: 'SDE <script>alert(1)</script> & "Intern" >_<', company: 'A&B' });

  const text = formatDigest(pendingDigestItems(db));
  assert.equal(text.includes('<script>'), false, 'no raw tag survives');
  assert.match(text, /&lt;script&gt;/);
  assert.match(text, /A&amp;B/, 'ampersands are escaped, including in the company name');

  // Every tag the message opens, it closes — the check Telegram actually applies.
  const opens = [...text.matchAll(/<(b|i|a|code)\b/g)].length;
  const closes = [...text.matchAll(/<\/(b|i|a|code)>/g)].length;
  assert.equal(opens, closes, text);
  db.close();
});

test('escaping touches exactly the three characters HTML mode cares about', () => {
  assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  // Not MarkdownV2: dots, dashes and brackets are left alone, which is why HTML was chosen.
  assert.equal(escapeHtml('SDE-1 (Backend) v2.0 [remote]'), 'SDE-1 (Backend) v2.0 [remote]');
});

test('a long digest splits between jobs, never inside one', () => {
  const block = 'x'.repeat(1_000);
  const text = Array.from({ length: 8 }, (_, i) => `${block}${i}`).join('\n\n');

  const parts = chunk(text);
  assert.ok(parts.length > 1, 'it did split');
  for (const part of parts) assert.ok(part.length <= MAX_MESSAGE_CHARS, `${part.length} chars`);
  // Nothing lost, nothing duplicated.
  assert.equal(parts.join('\n\n'), text);
});

test('a single block bigger than the limit is passed through rather than corrupted', () => {
  // Losing one absurd job beats cutting a message inside an <a href> and getting a 400 for
  // the whole digest.
  const huge = 'y'.repeat(MAX_MESSAGE_CHARS + 500);
  assert.deepEqual(chunk(huge), [huge]);
});
