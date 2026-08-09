import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, type Db } from './db.ts';
import { JobState, nowIso } from './schema.ts';
import {
  TRANSITIONS,
  canTransition,
  isTerminal,
  transition,
  tryTransition,
  stateOf,
  jobIdsInState,
  IllegalTransitionError,
} from './state.ts';

function seed(): { db: Db; jobId: number } {
  const db = openDb(':memory:');
  const now = nowIso();
  db.prepare(
    `INSERT INTO companies (name, domain, ats_type, ats_slug, careers_url, team_url,
                            created_at, updated_at)
     VALUES ('Acme', 'acme.com', 'greenhouse', 'acme', NULL, NULL, ?, ?)`,
  ).run(now, now);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO jobs (company_id, dedup_key, source, url, title, state,
                         state_changed_at, first_seen_at, last_seen_at)
       VALUES (1, ?, 'greenhouse', 'https://acme.com/j/1', 'SWE Intern', 'DISCOVERED', ?, ?, ?)`,
    )
    .run('a'.repeat(64), now, now, now);
  return { db, jobId: Number(lastInsertRowid) };
}

test('migrations are idempotent', () => {
  const db = openDb(':memory:');
  assert.equal(migrate(db), 0, 'second migrate applied something');
  db.close();
});

test('every state in the schema has a transition entry', () => {
  for (const state of JobState.options) {
    assert.ok(state in TRANSITIONS, `${state} missing from TRANSITIONS`);
  }
});

test('no transition points at an unknown state', () => {
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) {
      assert.ok(JobState.options.includes(to), `${from} → ${to} is not a real state`);
    }
  }
});

test('terminal states are exactly the ones the docs mark terminal', () => {
  const terminal = JobState.options.filter(isTerminal).sort();
  assert.deepEqual(terminal, [
    'BOUNCED',
    'CLOSED',
    'EXPIRED',
    'REJECTED',
    'REJECTED_BY_USER',
    'REPLIED',
  ]);
});

test('the happy path is walkable end to end', () => {
  const path: JobState[] = [
    'DISCOVERED',
    'SCORED',
    'MATCHED',
    'DRAFTED',
    'AUTO_SEND',
    'SENT',
    'REPLIED',
  ];
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransition(path[i]!, path[i + 1]!), `${path[i]} → ${path[i + 1]} should be legal`);
  }
});

test('transition advances the row', () => {
  const { db, jobId } = seed();
  transition(db, jobId, 'DISCOVERED', 'SCORED');
  assert.equal(stateOf(db, jobId), 'SCORED');
  db.close();
});

test('an illegal edge throws before touching the DB', () => {
  const { db, jobId } = seed();
  assert.throws(() => transition(db, jobId, 'DISCOVERED', 'SENT'), IllegalTransitionError);
  assert.equal(stateOf(db, jobId), 'DISCOVERED');
  db.close();
});

test('a stale expectation does not silently overwrite', () => {
  const { db, jobId } = seed();
  transition(db, jobId, 'DISCOVERED', 'SCORED');
  // A second pass still thinks the row is DISCOVERED — it must not win.
  assert.equal(tryTransition(db, jobId, 'DISCOVERED', 'EXPIRED'), false);
  assert.equal(stateOf(db, jobId), 'SCORED');
  assert.throws(() => transition(db, jobId, 'DISCOVERED', 'EXPIRED'), /was SCORED/);
  db.close();
});

test('jobIdsInState is what a stage picks up', () => {
  const { db, jobId } = seed();
  assert.deepEqual(jobIdsInState(db, 'DISCOVERED'), [jobId]);
  transition(db, jobId, 'DISCOVERED', 'SCORED');
  assert.deepEqual(jobIdsInState(db, 'DISCOVERED'), []);
  db.close();
});
