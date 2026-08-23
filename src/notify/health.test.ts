/**
 * The failure alert, and above all its silence.
 *
 * This is the message decision 014 refused in one form and this file permits in another, so
 * the tests are mostly about when it does *not* send. A message that arrives every morning is
 * one you stop reading; a message that arrives only when something newly broke is one you act
 * on. The dedupe is what separates those two things (decision 026).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../store/db.ts';
import { nowIso, type RunError } from '../store/schema.ts';
import { formatFaults, newFaults, previousFaults, reportFaults, signature } from './health.ts';

const CONFIG = { token: 't', chatId: '1' };
const fault = (stage: RunError['stage'], message: string): RunError => ({
  stage,
  message,
  at: nowIso(),
});

function fakeSend() {
  const calls: string[] = [];
  return { calls, send: async (_c: unknown, text: string) => void calls.push(text) };
}

/** A finished, non-dry run carrying `errors`. */
function seedRun(db: Db, errors: RunError[], dryRun = false): number {
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO runs (started_at, finished_at, dry_run, stats, errors) VALUES (?, ?, ?, ?, ?)',
    )
    .run(nowIso(), nowIso(), dryRun ? 1 : 0, '{}', JSON.stringify(errors));
  return Number(lastInsertRowid);
}

const log = () => {};

test('a healthy run says nothing at all', async () => {
  const db = openDb(':memory:');
  const { calls, send } = fakeSend();

  const sent = await reportFaults(db, 1, [], { dryRun: false, log }, { send, config: CONFIG });

  assert.deepEqual(sent, []);
  assert.equal(calls.length, 0, 'silence is the whole point');
  db.close();
});

test('a new fault is reported once', async () => {
  const db = openDb(':memory:');
  const { calls, send } = fakeSend();
  const errors = [fault('ingest', 'source gmail-alert failed: invalid_grant')];
  const runId = seedRun(db, errors);

  const sent = await reportFaults(db, runId, errors, { dryRun: false, log }, { send, config: CONFIG });

  assert.equal(sent.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /needs attention/);
  assert.match(calls[0]!, /invalid_grant/);
  db.close();
});

test('the same fault tomorrow is silent — one message, not fourteen', async () => {
  // Gmail's token was expired from 08-19 to 08-23. Four mornings, one problem.
  const db = openDb(':memory:');
  const { calls, send } = fakeSend();
  const errors = [fault('ingest', 'source gmail-alert failed: invalid_grant')];

  seedRun(db, errors);
  const today = seedRun(db, errors);
  const sent = await reportFaults(db, today, errors, { dryRun: false, log }, { send, config: CONFIG });

  assert.deepEqual(sent, []);
  assert.equal(calls.length, 0);
  db.close();
});

test('a second, different fault does get reported while the first is ongoing', async () => {
  const db = openDb(':memory:');
  const { calls, send } = fakeSend();
  const ongoing = fault('ingest', 'source gmail-alert failed: invalid_grant');
  const fresh = fault('digest', 'stage exceeded its 8 min budget');

  seedRun(db, [ongoing]);
  const today = seedRun(db, [ongoing, fresh]);
  const sent = await reportFaults(db, today, [ongoing, fresh], { dryRun: false, log }, { send, config: CONFIG });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.stage, 'digest');
  assert.doesNotMatch(calls[0]!, /invalid_grant/, 'yesterday’s news stays out of it');
  db.close();
});

test('numbers in a message do not make it a new fault', () => {
  // "exceeded its 12 min budget" then "…8 min budget" is one ongoing problem, and a message
  // carrying a job id must not re-alert every morning.
  assert.equal(
    signature(fault('ingest', 'stage exceeded its 12 min budget')),
    signature(fault('ingest', 'stage exceeded its 8 min budget')),
  );
  assert.notEqual(
    signature(fault('ingest', 'stage exceeded its budget')),
    signature(fault('digest', 'stage exceeded its budget')),
    'the same words from a different stage are a different problem',
  );
});

test('the same fault twice in one run is one line', () => {
  const dupe = fault('ingest', 'source gmail-alert failed: invalid_grant');
  assert.equal(newFaults([dupe, dupe], []).length, 1);
});

test('a dry run reports nothing outward', async () => {
  const db = openDb(':memory:');
  const { calls, send } = fakeSend();
  const errors = [fault('score', 'fetch failed')];
  const runId = seedRun(db, errors);

  const sent = await reportFaults(db, runId, errors, { dryRun: true, log }, { send, config: CONFIG });

  assert.equal(sent.length, 1, 'it still says what it would have sent');
  assert.equal(calls.length, 0, 'but sends nothing');
  db.close();
});

test('a failure to report a failure does not throw', async () => {
  // This runs after the stages, at the end of the pipeline. It must not be the thing that
  // breaks the run.
  const db = openDb(':memory:');
  const errors = [fault('score', 'fetch failed')];
  const runId = seedRun(db, errors);

  const sent = await reportFaults(
    db,
    runId,
    errors,
    { dryRun: false, log },
    { send: async () => { throw new Error('telegram is down too'); }, config: CONFIG },
  );

  assert.deepEqual(sent, []);
  db.close();
});

test('dry runs are ignored when working out what is new', () => {
  // A --dry-run in the afternoon must not silence tomorrow morning's real alert.
  const db = openDb(':memory:');
  const errors = [fault('ingest', 'source gmail-alert failed: invalid_grant')];
  seedRun(db, errors, true);
  const runId = seedRun(db, errors);

  assert.deepEqual(previousFaults(db, runId), [], 'the dry run is not the baseline');
  db.close();
});

test('the message names the stage, the reason, and what to run', () => {
  const text = formatFaults([fault('ingest', 'source gmail-alert failed: invalid_grant')]);
  assert.match(text, /<b>ingest<\/b>/);
  assert.match(text, /invalid_grant/);
  assert.match(text, /logs\/daily\.log/, 'a message with no next step is a worry, not a report');
});
