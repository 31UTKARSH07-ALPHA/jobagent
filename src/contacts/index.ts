/**
 * The contacts stage: `MATCHED` jobs → an address to write to, or `NEEDS_CONTACT`.
 *
 * The work is **per company**, not per job (decision 005). Two open roles at the same firm
 * share one cascade, one set of page fetches and one contact row, which is what makes
 * discovery viable on a free-tier budget at all.
 *
 * Three things happen per company, in this order, and the first is the one `phases.md` did
 * not anticipate:
 *
 * 1. **Resolve the domain** if it is still an `.unknown.invalid` marker. 73 of the 78 matched
 *    jobs are in that position, and every rung of the cascade keys off a domain (decision 030).
 * 2. **Run the cascade** for an address, then MX-check it before it is stored.
 * 3. **Advance the jobs**: `DRAFTED` when there is a contact, `NEEDS_CONTACT` when there is
 *    not — retried every 3 days, 3 times, then `EXPIRED`.
 *
 * Nothing here sends anything, and nothing here writes a draft. `DRAFTED` means "this job has
 * a contact and is ready for the draft stage", which is the state machine's own reading of it
 * (`docs/architecture.md`).
 */
import type { StageContext } from '../stage.ts';
import { adoptDomain, companyById } from '../store/companies.ts';
import { transaction } from '../store/db.ts';
import { isUnknownDomain } from '../ingest/resolve-company.ts';
import {
  CONTACT_RETRY_DAYS,
  MAX_CONTACT_ATTEMPTS,
  jobIdsInState,
  tryTransition,
} from '../store/state.ts';
import { confidenceForSource, nowIso, type JobState } from '../store/schema.ts';
import { bestContact, findContacts } from './cascade.ts';
import { discoverDomain } from './domain.ts';
import { mxValid } from './verify.ts';

/**
 * How long one company gets before the stage moves on.
 *
 * The same reasoning as `SOURCE_BUDGET_MS` in ingest (decision 025): a stage budget says when
 * to stop, not who got the time. Up to twelve DNS probes and four page fetches per company,
 * with dozens of companies queued behind it, is exactly the shape that let one hung host eat
 * a whole stage. Measured live, a healthy company resolves in 0.5–11 seconds.
 */
export const COMPANY_BUDGET_MS = 45_000;

/**
 * Companies allowed to reach Groq for a domain in one run.
 *
 * The model rescued 1 of 12 names the heuristics missed (decision 030), so this is a small
 * cap on a small benefit — its real purpose is to keep the contacts stage from queueing
 * dozens of calls in front of scoring, which shares the same 8,000 tokens/minute (017).
 */
export const MAX_LLM_DOMAINS_PER_RUN = 15;

/**
 * Companies allowed to ask GitHub in one run. Unauthenticated, GitHub allows 60 requests an
 * hour from an IP — shared with nothing else here, but not worth spending on a rung that
 * yields an org's public address at best.
 */
export const MAX_GITHUB_LOOKUPS_PER_RUN = 20;

/** A company with matched work waiting on it, and the jobs waiting. */
type Pending = {
  company_id: number;
  name: string;
  domain: string;
  jobs: { id: number; state: JobState; title: string; description: string }[];
};

/**
 * Jobs that need a contact: everything `MATCHED`, plus the `NEEDS_CONTACT` rows whose retry
 * has come round, grouped by company.
 *
 * The retry window is enforced in SQL rather than in the loop so a company with one due job
 * and three not-due ones is still visited once, for the due one.
 */
export function pendingByCompany(ctx: StageContext): Pending[] {
  const cutoff = new Date(Date.now() - CONTACT_RETRY_DAYS * 86_400_000).toISOString();

  const rows = ctx.db
    .prepare(
      `SELECT j.id, j.state, j.title, j.description, c.id AS company_id, c.name, c.domain
         FROM jobs j
         JOIN companies c ON c.id = j.company_id
        WHERE j.state = 'MATCHED'
           OR (j.state = 'NEEDS_CONTACT'
               AND j.contact_attempts < ?
               AND (j.last_contact_attempt_at IS NULL OR j.last_contact_attempt_at < ?))
        ORDER BY c.id, j.id`,
    )
    .all(MAX_CONTACT_ATTEMPTS, cutoff) as {
    id: number;
    state: JobState;
    title: string;
    description: string;
    company_id: number;
    name: string;
    domain: string;
  }[];

  const byCompany = new Map<number, Pending>();
  for (const row of rows) {
    const entry = byCompany.get(row.company_id) ?? {
      company_id: row.company_id,
      name: row.name,
      domain: row.domain,
      jobs: [],
    };
    entry.jobs.push({ id: row.id, state: row.state, title: row.title, description: row.description });
    byCompany.set(row.company_id, entry);
  }

  return [...byCompany.values()];
}

/** The contact this company already has, if the cascade has run for it before. */
function cachedContact(ctx: StageContext, companyId: number): { id: number; email: string } | null {
  return (
    (ctx.db
      .prepare(
        `SELECT id, email FROM contacts
          WHERE company_id = ? AND (mx_valid IS NULL OR mx_valid = 1)
          ORDER BY CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id
          LIMIT 1`,
      )
      .get(companyId) as { id: number; email: string } | undefined) ?? null
  );
}

/**
 * Record an attempt against every job of a company that produced nothing.
 *
 * `MATCHED` rows move to `NEEDS_CONTACT`; rows already there stay put and only have their
 * counter bumped, because the state machine has no `NEEDS_CONTACT → NEEDS_CONTACT` edge and
 * should not — a self-loop would make `state_changed_at` meaningless.
 */
function recordFailure(ctx: StageContext, pending: Pending): void {
  const now = nowIso();

  transaction(ctx.db, () => {
    for (const job of pending.jobs) {
      ctx.db
        .prepare(
          'UPDATE jobs SET contact_attempts = contact_attempts + 1, last_contact_attempt_at = ? WHERE id = ?',
        )
        .run(now, job.id);

      if (job.state === 'MATCHED') {
        tryTransition(ctx.db, job.id, 'MATCHED', 'NEEDS_CONTACT');
        continue;
      }

      // Out of attempts. A posting nobody can be found for is not worth carrying forever.
      const attempts = ctx.db.prepare('SELECT contact_attempts AS n FROM jobs WHERE id = ?').get(job.id) as
        | { n: number }
        | undefined;
      if ((attempts?.n ?? 0) >= MAX_CONTACT_ATTEMPTS) {
        tryTransition(ctx.db, job.id, 'NEEDS_CONTACT', 'EXPIRED');
        ctx.count('expired');
      }
    }
  });
}

export type ContactsDeps = {
  /** Swapped out in tests; the real one talks to DNS and the open web. */
  findContacts?: typeof findContacts;
  discoverDomain?: typeof discoverDomain;
  mxValid?: typeof mxValid;
};

export async function runContacts(ctx: StageContext, deps: ContactsDeps = {}): Promise<void> {
  const find = deps.findContacts ?? findContacts;
  const discover = deps.discoverDomain ?? discoverDomain;
  const checkMx = deps.mxValid ?? mxValid;

  const pending = pendingByCompany(ctx);
  if (pending.length === 0) {
    ctx.log('no matched jobs waiting for a contact');
    return;
  }

  const jobCount = pending.reduce((n, p) => n + p.jobs.length, 0);
  ctx.log(`${jobCount} job(s) across ${pending.length} company(ies)`);

  let llmBudget = MAX_LLM_DOMAINS_PER_RUN;
  let githubBudget = MAX_GITHUB_LOOKUPS_PER_RUN;

  for (const company of pending) {
    if (ctx.signal.aborted) {
      ctx.log('out of time — the rest keep their state and are retried next run');
      ctx.count('out_of_time');
      break;
    }

    // One company cannot spend the whole stage (decision 025).
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(COMPANY_BUDGET_MS)]);

    try {
      let { company_id: companyId, domain } = company;

      // 1. A marker domain has to become a real one before anything else can happen.
      if (isUnknownDomain(domain)) {
        const hint = company.jobs[0]?.title ?? '';
        const found = await discover(company.name, {
          signal,
          hint,
          allowLlm: llmBudget > 0,
          log: (m) => ctx.log(m),
        });
        if (found?.via === 'llm') llmBudget--;

        if (found === null) {
          ctx.count('domain_unresolved');
          recordFailure(ctx, company);
          continue;
        }

        // The company may merge into an existing row here, so the id can change.
        companyId = adoptDomain(ctx.db, companyId, found.domain);
        domain = found.domain;
        ctx.count('domain_resolved');
      }

      // 2. A contact already on file is the whole point of caching per company.
      const cached = cachedContact(ctx, companyId);

      if (cached === null) {
        const useGithub = githubBudget > 0;
        if (useGithub) githubBudget--;

        const candidates = await find(
          { name: company.name, domain },
          {
            signal,
            postings: company.jobs.map((j) => j.description).filter((d) => d !== ''),
            allowGithub: useGithub,
          },
        );

        // The MX check is passed in rather than left to the default, so that a contact is
        // only ever stored after the domain has been shown to accept mail (decision 030).
        const best = await bestContact(candidates, checkMx);
        if (best === null) {
          ctx.count('no_contact');
          ctx.log(`${company.name}: nothing usable at ${domain}`);
          recordFailure(ctx, company);
          continue;
        }

        const confidence = confidenceForSource(best.source);

        // `contacts.email` is globally unique. An address already on file belongs to
        // whichever company found it first and stays there — a recruiting agency handling
        // two companies is a real thing, and silently re-assigning the row would move every
        // draft ever written against it.
        const held = ctx.db.prepare('SELECT id, company_id FROM contacts WHERE email = ?').get(best.email) as
          | { id: number; company_id: number }
          | undefined;

        if (held !== undefined) {
          if (held.company_id !== companyId) ctx.log(`${company.name}: ${best.email} is already on file`);
        } else {
          ctx.db
            .prepare(
              `INSERT INTO contacts (company_id, email, name, title, source, confidence, mx_valid, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            // `mx_valid` is always 1: `bestContact` only returns an address whose domain
            // answered, so an address that failed the check is never stored at all.
            .run(companyId, best.email, best.name, best.title, best.source, confidence, 1, nowIso());
          ctx.count(`found_${best.source}`);
          ctx.log(`${company.name}: ${best.email} (${best.source}, ${confidence}) from ${best.found_at}`);
        }
      } else {
        ctx.count('cached');
      }

      // 3. Every waiting job at this company now has somewhere to write to.
      transaction(ctx.db, () => {
        for (const job of company.jobs) {
          if (tryTransition(ctx.db, job.id, job.state, 'DRAFTED')) ctx.count('ready_to_draft');
        }
      });
    } catch (err) {
      // A company that blows up leaves its jobs exactly where they were; the next run
      // retries them. This is a fault rather than a log line because a company failing every
      // day is a real problem that the health check should surface (decision 026).
      const message = err instanceof Error ? err.message : String(err);
      ctx.count('failed');
      ctx.fault(`${company.name}: ${message}`);
    }
  }
}
