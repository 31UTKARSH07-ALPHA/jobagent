/**
 * The stage budget.
 *
 * Written after 2026-08-20, when a run with intermittent DNS spent 33 minutes in ingest and
 * 27 minutes on one scoring call, and the digest — the only stage anyone sees — ran last and
 * failed. A per-request timeout cannot bound that; 51 boards × 3 attempts is entitled to take
 * an hour. What matters here is that a stuck stage cannot stop the ones after it
 * (decision 022).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './store/db.ts';
import {
  DEFAULT_STAGE_BUDGET_MS,
  STAGE_BUDGET_MS,
  STAGES,
  SUSPEND_OVERSHOOT_MS,
  main,
  sleptThrough,
  suspendedFault,
} from './main.ts';

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'jobagent-')), 'test.db');

test('every daily stage has a budget, explicit or default', () => {
  // The default exists so a new stage cannot be added without one by accident.
  assert.ok(DEFAULT_STAGE_BUDGET_MS > 0);
  for (const name of Object.keys(STAGES)) {
    assert.ok((STAGE_BUDGET_MS[name] ?? DEFAULT_STAGE_BUDGET_MS) > 0, name);
  }
});

test('scoring gets long enough for a full queue', () => {
  // MAX_SCORES_PER_RUN is 60 and the pacer takes ~67s per job, so a budget under ~67
  // minutes would cut a full morning off mid-run and look like a scoring bug.
  assert.ok((STAGE_BUDGET_MS['score'] ?? 0) >= 67 * 60_000);
});

test('a stage that hangs is abandoned, and the stages after it still run', async () => {
  const db = tmpDb();
  const original = { ...STAGES };
  let laterStageRan = false;
  let hungSawAbort = false;

  // A stage that ignores its signal entirely — the uninterruptible case, which is the one
  // that actually happened.
  STAGES['ingest'] = {
    phase: 1,
    run: async (ctx) => {
      ctx.signal.addEventListener('abort', () => {
        hungSawAbort = true;
      });
      await new Promise((r) => setTimeout(r, 1_000));
    },
  };
  STAGES['digest'] = {
    phase: 1,
    run: async () => {
      laterStageRan = true;
    },
  };
  STAGE_BUDGET_MS['ingest'] = 120;

  try {
    const code = await main(['--db', db, '--dry-run']);
    assert.equal(code, 0, 'the run itself still succeeds');
    assert.equal(hungSawAbort, true, 'the stage is told it is out of time');
    assert.equal(laterStageRan, true, 'the digest still got its turn');

    // The overrun is recorded, not swallowed.
    const conn = openDb(db);
    const row = conn.prepare('SELECT errors FROM runs ORDER BY id DESC LIMIT 1').get() as {
      errors: string;
    };
    assert.match(row.errors, /budget/);
    conn.close();
  } finally {
    Object.assign(STAGES, original);
    delete STAGE_BUDGET_MS['ingest'];
    STAGE_BUDGET_MS['ingest'] = 12 * 60_000;
  }
});

test('a stage that merely ignores its signal is not blamed on the laptop', () => {
  // The two failures look identical in the log and lead opposite ways, so the line between
  // them has to be somewhere no real overshoot reaches. A stage stuck in one uninterruptible
  // call overshoots by that call: a 5s DNS probe, a 20s HTTP timeout (decisions 028, 029).
  const budget = 12 * 60_000;
  assert.equal(sleptThrough(budget + 5_000, budget), false, 'a hung DNS lookup');
  assert.equal(sleptThrough(budget + 20_000, budget), false, 'a hung HTTP request');
  assert.equal(sleptThrough(budget + SUSPEND_OVERSHOOT_MS, budget), false, 'the boundary is exclusive');
});

test('a stage the machine slept through is recognised as exactly that', () => {
  // The five overshoots measured on 2026-09-05, smallest first. A `setTimeout` does not run
  // while the process is suspended, so this is the only shape that produces them.
  const budget = 15 * 60_000;
  assert.equal(sleptThrough(budget + 139_000, budget), true, 'contacts, the smallest of them');
  assert.equal(sleptThrough(17 * 60_000, 8 * 60_000), true, 'the digest, over twice its budget');
});

test('one fault for the run, naming every stage and the worst of them', () => {
  // The five stages of 2026-09-05. Five faults for one shut lid would send five alerts (026).
  const said = suspendedFault([
    { name: 'ingest', elapsed: 1_016_670, budgetMs: 12 * 60_000 },
    { name: 'contacts', elapsed: 1_039_230, budgetMs: 15 * 60_000 },
    { name: 'draft', elapsed: 1_596_499, budgetMs: 20 * 60_000 },
    { name: 'digest', elapsed: 1_059_914, budgetMs: 8 * 60_000 },
  ]);

  assert.ok(said !== null);
  for (const stage of ['ingest', 'contacts', 'draft', 'digest']) assert.match(said, new RegExp(stage));
  // The digest overran by 9.7 minutes; the draft stage only by 6.6, despite running longer.
  assert.match(said, /worst digest at 18m against a 8m budget/);
  assert.match(said, /symptom of that, not the cause/, 'the clause the whole thing exists for');
});

test('a healthy run says nothing about power at all', () => {
  assert.equal(suspendedFault([]), null);
});
