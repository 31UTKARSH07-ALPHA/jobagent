# Architecture

Stable design reference. If something here contradicts the code, the code is right and
this file is a bug — fix it.

## Core principle

**State lives in SQLite, not in the pipeline process.** The daily run is not a script
that holds data in memory from top to bottom. It is a set of stages that each pick up
rows in a given state, do work, and advance the state.

This buys us:

- A crash at stage 5 does not lose stages 1–4. Tomorrow's run resumes.
- Anthropic API down → jobs sit in `DISCOVERED` and get scored tomorrow. Self-healing,
  no retry queue, no dead-letter table.
- Any stage can be re-run in isolation while developing.

## Job lifecycle

```
                 DISCOVERED
                     │  scorer
                     ▼
                  SCORED
              ┌──────┴──────┐
      score < 70           score >= 70
          ▼                    ▼
      REJECTED ●            MATCHED
                               │  contact finder
                      ┌────────┴────────┐
                 not found            found
                      ▼                 ▼
               NEEDS_CONTACT         DRAFTED
              (retry 3d, x3)            │  gate
                      │                 │
                      ▼         ┌───────┴───────┐
                  EXPIRED ●     │               │
                        high-conf email   everything
                        AND score > 85       else
                              ▼               ▼
                          AUTO_SEND    PENDING_APPROVAL
                              │               │ user taps
                              │         ┌─────┴─────┐
                              │     approve      reject
                              │         │           ▼
                              └─────────┤   REJECTED_BY_USER ●
                                        ▼  sender
                                      SENT
                           ┌────────────┼────────────┐
                        reply      no reply @ d4    bounce
                           ▼            ▼             ▼
                       REPLIED ●  FOLLOW_UP_SENT   BOUNCED ●
                                        │
                                  no reply @ d10
                                        ▼
                                     CLOSED ●
```

`●` = terminal. `EXPIRED` also applies when a posting disappears from its source.

Transitions are enforced in one place — see `src/store/state.ts`. Do not mutate
`jobs.state` directly from a stage.

## Data model

Canonical definitions live in `src/store/schema.ts` (Zod) and `src/store/migrations/`.
This section explains the *non-obvious* parts only.

| Table | Purpose |
|---|---|
| `companies` | Dedup on normalised domain. Holds ATS type + slug, careers/team URLs. |
| `jobs` | One row per posting. Carries `state`. |
| `job_scores` | PK `(job_id, prompt_version)`. Holds the four factor ratings *and* the score computed from them. |
| `contacts` | Scoped to **company**, not job. `unique(email)`. |
| `outreach` | `unique(job_id)`. Holds Gmail IDs + timestamps, and its **own** `digested_at` — a job is reported once as a match and again when its draft is ready (migration 005). |
| `runs` | One row per pipeline execution: stats + errors. |

### Why `jobs.dedup_key`

The same internship appears on Greenhouse *and* in a LinkedIn alert email. Key is:

```
sha256(company_domain + normalise(title) + normalise(location))
```

Catches ~90% of duplicates for free. The remaining ~10% (reworded titles) are caught by
a cosine-similarity check against embeddings we already compute in the prefilter — no
extra cost, no extra model call.

### Why `contacts` is company-scoped

This is what makes free-tier contact discovery viable. The expensive cascade
(team-page scrape → GitHub commit emails → pattern inference) runs **once per company**,
not once per job. After a few weeks the cache is warm and most new postings resolve
instantly.

### Why `job_scores` is keyed on `prompt_version`

Changing the scoring rubric should not destroy score history. Bump `prompt_version`,
re-score, compare distributions before switching thresholds.

### Why the scorer does not choose the score

The model rates four narrow factors 0–10 (`level_fit`, `location_fit`, `stack_fit`,
`domain_fit`); `fitScore()` in `src/match/score.ts` does the arithmetic and applies the two
hard gates. Asked for one holistic 0–100 number, the same posting scored 55, 78, 90 and 92
on four identical prompts — and `REJECTED` is terminal. Decision 012 has the measurements.

## Stage contracts

| # | Stage | Reads | Writes | Cadence |
|---|---|---|---|---|
| 1 | Ingest | source adapters, incl. Gmail alert mail | `jobs` (upsert), `companies` | daily |
| 2 | Prefilter | `jobs` @ DISCOVERED | in-memory → top ~30 | daily |
| 3 | Score | `jobs` @ DISCOVERED (prefilter is not built — see `phases.md`) | `job_scores`, state | daily |
| 4 | Contacts | `jobs` @ MATCHED, and NEEDS_CONTACT rows whose 3-day retry is due | `contacts`, **`companies.domain`**, state | daily |
| 5 | Draft | job + score + contact | `outreach` @ DRAFTED, Gmail draft | daily |
| 6 | Digest | `jobs` @ MATCHED with `digested_at IS NULL` | Telegram, `jobs.digested_at` | daily |
| 7 | Gate + Send | `outreach` @ DRAFTED / approved | Gmail, state → SENT | daily + on-approval |
| 8 | Track | `outreach` @ SENT | replies, bounces, follow-ups | **every 4h** |

There is deliberately **no separate normalise stage**. Each source adapter implements
`JobSource` (`src/ingest/types.ts`) and emits already-canonical rows:

```ts
interface JobSource {
  readonly name: string;
  fetch(since: Date): AsyncIterable<RawJob>;
}
```

Greenhouse, Lever, Ashby, Workable and GmailAlerts all satisfy this. Adding a source is one
new file plus one line in the registry.

The Gmail source is the one adapter that receives a company **name** rather than a board whose
owner is already known, so it is constructed with the DB and resolves the name to a domain via
`src/ingest/resolve-company.ts` — an unresolvable name becomes an explicit
`something.unknown.invalid` marker rather than a guess (decision 016). Its per-format parsers
live in `src/ingest/*-alert.ts`; one entry in `PARSERS` adds a format.

**Stage 4 writes `companies` as well as `contacts`, which the table above did not originally
say.** Alert-sourced companies arrive with an `.unknown.invalid` marker instead of a domain
(decision 016), and every rung of the cascade keys off a domain — so the stage's first act is
to resolve and *prove* one, then adopt it. Adoption can **merge two company rows** when the
proven domain already belongs to one (`adoptDomain` in `src/store/companies.ts`): the marker's
jobs are re-pointed, their `dedup_key`s re-hashed against the new domain, and the marker row
deleted. Decisions 030 and 031.

Stage 8 runs on its **own schedule**, not as part of the daily pipeline. Replies and
bounces arrive continuously; checking once a day wastes a day.

The digest sits *before* send, not after: it is what you read at 06:05, while nothing leaves
until 09:00. From Phase 2 it also carries the drafts awaiting approval.

## Idempotency

The pipeline must be safe to run twice in a row.

| Stage | Rule |
|---|---|
| Ingest | Upsert on `dedup_key`; bump `last_seen_at` |
| Score | Only picks up DISCOVERED rows; a `(job_id, prompt_version)` row already there is reused rather than re-requested. `--rescore` is the out-of-band path for a rubric bump: writes scores, never states |
| Contacts | Skip if the company already has a contact |
| Digest | Skip if `jobs.digested_at` is set; it is set only after Telegram accepts the message |
| Draft | Skip if an `outreach` row exists for `job_id` |
| Send | See below |

### Send idempotency — the one that matters

A double-send is the only bug in this project with real-world consequences.

1. Create a **Gmail draft**, persist `gmail_draft_id`.
2. Send with `drafts.send(draft_id)` — never `messages.send`.
3. If the send call fails ambiguously (timeout, socket drop), query Gmail for that
   draft: gone → it sent; still there → safe to retry.

Plus `UNIQUE(job_id)` on `outreach` as a hard backstop.

This also gives one code path for auto-sent and manually-approved mail, and a full audit
trail in the real Gmail Sent folder.

## Model routing

All three LLM jobs run on **Groq's free tier** (decision 011). Total API spend: $0.

| Job | Frequency | Notes |
|---|---|---|
| Resume PDF → profile | Once ever | Quality matters most; re-run by hand if it looks wrong. |
| Score ~30 jobs/day | Daily | Rubric task with Zod-validated structured output. |
| Draft ~5 emails/day | Daily | The only output a human reads — the quality-sensitive one. |

Every call goes through `src/llm/`, which exposes one interface per job. Moving a single
stage to another provider is a one-file change; decision 011 records the intended escape
hatch (drafting → `claude-opus-5`, ~$3.75/month) if reply rates disappoint.

**Model IDs are verified, not remembered.** Groq's catalogue changes; `src/llm/models.ts`
is checked against the live `/openai/v1/models` endpoint rather than hard-coded from
memory — same rule as ATS slugs (decision 010).

## Daily timeline

```
06:00  ingest → prefilter → score → contacts → draft → digest
       └─ scoring is the long pole: ~67s per job (see below)
       launchd agent com.utkarsh.jobagent.daily → scripts/run-daily.sh (decision 018)
09:00  sends begin, jittered 3–15 min apart, under the daily cap
       ├─ AUTO_SEND items fire on schedule
       └─ approved items join the queue as taps arrive
*/4h   tracker: replies, bounces, follow-ups due
Sun    company-list refresh, prune dead ATS slugs
```

**The digest does not arrive at a fixed time, and cannot.** Measured 2026-08-12: 9 jobs took
**10m02s** — about 67 seconds each, because the free tier allows two ~4,000-token scoring calls
per minute and the pacer waits for real headroom rather than being refused (decision 017). So a
30-job morning finishes around 06:35 and the `MAX_SCORES_PER_RUN` ceiling of 60 around 07:10.

That is fine for a digest read over breakfast, and the 09:00 send window is untouched. But it
is the reason `src/match/embed.ts` — the bge-small prefilter, deferred while volume was five
jobs a day — earns its keep as volume grows: it cuts the *number* of scoring calls, which is
the only lever that shortens this materially. Trimming the prompt is the smaller lever.

Sends are delayed to 09:00 and jittered on purpose. Five emails leaving the same domain
in the same second is the most robotic signal available.

## Failure semantics

- Every stage is wrapped. Errors land in `runs.errors` and never abort the run.
- Source adapters are isolated — Lever 500ing does not stop Greenhouse.
- A failed stage leaves rows in their current state; the next run retries them.
- `NEEDS_CONTACT` retries the cascade every 3 days, 3 attempts, then `EXPIRED`.

## Deliberate non-goals

- **No LinkedIn/Naukri scraping.** Ban risk, and Gmail alert-parsing gets the same jobs.
- **No paid contact APIs** beyond Hunter's 25 free lookups/month.
- **No Postgres, no vector extension.** A few thousand JDs; brute-force cosine over
  `Float32Array` is single-digit milliseconds.
- **No web UI.** Telegram is the whole interface.
