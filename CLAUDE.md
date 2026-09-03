# jobagent

Daily agent that ingests SWE/AI-ML internship postings, scores them against my resume,
finds recruiter contacts, and drafts/sends personalised cold emails.

**This file is auto-loaded into every session. Keep it under ~100 lines.**
Everything else lives in `docs/` and is read on demand.

## Stack

- **Node 25** — runs `.ts` files natively, no build step in dev, no bundler
- **`node:sqlite`** — built in, no native compile. DB at `data/jobagent.db`
- **Groq free tier** — scores *and* drafts, behind `src/llm/` so a provider swap is
  one file (decision 011 — supersedes 003, which used Anthropic and cost ~$7/mo)
- **Zod** — `src/store/schema.ts` is the single source of truth for every shape
- **`@huggingface/transformers`** — bge-small embeddings, local, free
- **`@googleapis/gmail`** — Gmail read/draft/send. The per-API package: 1.2MB, versus
  206MB for the umbrella `googleapis`. Same client (decision 015)
- **Telegram** — plain `fetch` in `src/notify/telegram.ts`, for sending *and* for approve/
  reject taps. `grammy` was reserved for Phase 3 and turned out not to be needed: a framework
  holds a long poll open in a daemon, and the ten-minute send agent can just poll the
  `getUpdates` cursor (decision 042)

## Commands

```bash
node src/main.ts                  # full daily pipeline
node src/main.ts --stage=score    # run one stage in isolation
node src/main.ts --dry-run        # everything except sending
node --test                       # tests

node src/match/score.ts --job=12       # score one job, print it, write nothing
node src/match/score.ts --distribution # the histogram the calibration gate reads
node src/match/score.ts --rescore      # re-score at the current PROMPT_VERSION, no state change
node src/notify/telegram.ts --test     # prove the bot is wired up
node src/notify/approve.ts --watch     # did my button tap reach the bot?
node src/gmail/auth.ts                 # authorise Gmail (opens a browser, once)
node src/gmail/auth.ts --status        # which account, which scopes
node src/gmail/messages.ts --query="from:naukri.com" --links --full   # inspect real mail

node src/contacts/domain.ts --name="Convin" [--llm]  # name → verified domain, prints candidates
node src/draft/index.ts --job=12                     # compose one draft, print it, write nothing
node src/draft/index.ts --redraft                    # rewrite every unsent Gmail draft in place
node src/track/replies.ts --status                  # the outreach ledger: sent, replied, bounced

node src/main.ts --fast                # the hourly lane: ingest → score → alert only
./scripts/run-daily.sh                 # exactly what launchd runs at 06:00
node src/schedule/launchd.ts --status  # both agents: loaded? last exit code? how many runs?
node src/schedule/launchd.ts --install # (re)write and load both; --job=hourly narrows
```

## Invariants — violating these causes real-world damage

1. **Never call `gmail.messages.send`.** Always `drafts.create` → store `gmail_draft_id`
   → `drafts.send(id)`. One code path for auto and approved. See `docs/architecture.md`.
   **After an ambiguous failure, ask whether it is still a *draft*, never whether it still
   exists** — `drafts.get` returns 200 for a draft it has already sent, labelled `SENT`
   rather than `DRAFT`. Getting that backwards mails somebody twice (decision 044).
2. **`outreach` has `UNIQUE(job_id)`.** Double-sending is structurally impossible. Keep it.
3. **Pattern-guessed emails never auto-send.** Only `confidence='high'` contacts
   (from the posting itself or a company team page) are eligible.
4. **Every stage is idempotent.** Re-running the pipeline twice must be a no-op.
   Rules per stage are in `docs/architecture.md`.
5. **Respect the daily send cap and the ramp.** Hard-coded, not configurable at runtime.
6. **State lives in SQLite, never in memory across stages.** A crash mid-run must be
   recoverable by just running again.

## Non-obvious facts

- **Hand-run CLIs load `.env` themselves** (`src/env.ts`). Only `scripts/run-daily.sh` passes
  `--env-file-if-exists`; a command you type does not, and every documented one-off used to
  fail claiming the bot token was unset. Library code must never call it — a stage takes its
  configuration from the environment it was given.
- **The tap cursor is consumed by whichever process polls first** (043). The ten-minute agent
  usually gets there before you do, which makes a manual `getUpdates` look empty and a working
  approval loop look broken. `--watch` exists for this and does not advance the cursor.

- **Never ask a model for a 0–100 score.** The scorer rates four factors 0–10 and
  `fitScore()` does the arithmetic. Asked for the number directly, the same posting came
  back 55, 78, 90 and 92 — and `REJECTED` is terminal. Decision 012.
- **A missing job description costs 15% of the total, never the factor ratings themselves**
  (decision 023, rubric v4). Clamping `stack_fit`/`domain_fit` to 6 made 31 of 32 alert
  postings score *exactly* 82 — the score ranked nothing. Store what the model said; discount
  the result. Title-only tops out at 84, still under the 85 Phase 3 needs to auto-send.
- Groq is not reproducible even at `temperature: 0` — no seed, batched MoE. Design the
  variance out; do not retry it away.
- Groq model IDs are **verified against the live `/models` endpoint**, never hard-coded
  from memory. Its catalogue changes. Same rule that `data/companies.json` follows.
- Groq charges `prompt + max_tokens` at submission against an 8,000/min budget, so pacing is
  a token window (`src/llm/rate-limit.ts`), not a timer. Never raise `max_tokens` for
  "headroom" — it is billed whether used or not (decisions 013, 017).
- **There is also a 200,000 tokens/*day* ceiling**, which the pacer does not model. A daily run
  is nowhere near it; a full re-score (~139 jobs ≈ 300k) does not fit in one day. Split it, or
  expect to resume — `--rescore` continues where it stopped (decision 045).
- Sends are jittered 3–15 min apart starting 09:00. Never fire them all at pipeline time.
- **Sending is disarmed by default** (040). `JOBAGENT_SEND=armed` in `.env` is the only thing
  that lets real mail leave; without it the send stage gates, schedules and logs what it would
  have done. Never arm it to "test" something.
- **A job's score is its newest, never its highest** (041) — `CURRENT_FIT_SCORE`. Reading
  `MAX(fit_score)` across rubric versions cleared a title-only posting to auto-send on an
  obsolete v2 score of 100 that v4 had replaced with 84.
- **Three schedules, not one** (036, 040): 06:00 daily runs everything; an hourly agent runs
  `ingest → score → alert → track` in ~45s; a sender runs every 10 min so the 09:00 jitter
  means something. `run-daily.sh` holds a lock so they cannot overlap, and
  each writes its own log. Alert-email postings were reaching the pipeline 3–12h late purely
  because the poll was daily.
- **Only published addresses are drafted right now** (035) — `DRAFTABLE_CONFIDENCE`. Guesses
  are one constant away from being turned back on, pending evidence they get replies.
- LinkedIn/Naukri are ingested by parsing *my own Gmail job-alert emails*, never scraped.
  Alert postings therefore have **no description** — the scorer judges them on title,
  company and location alone (decision 016). Naukri's parser reads the URL *slug*, not the
  visible text, which truncates the company name.
- Contacts are cached per **company**, not per job. Assume the cache is warm.
- **Spam placement is undetectable from the sender side** (037). A message filed as spam
  completed its SMTP transaction — nothing comes back. Only a *rejection* is observable, which
  is why `bounce_reason` separates `unknown-mailbox` (fix the cascade) from `blocked` (fix the
  account's standing). Never add a tracking pixel to measure this: it is itself a bulk signal.
- **A guessed domain is never believed without proof** — MX records *and* the company's whole
  name on its live home page (decision 030). Two of 69 candidate domains were parked pages that
  resolve and serve HTML, and three more were English words on somebody else's site.
- **Two Groq calls deliberately skip structured output**: the domain lookup and the drafter.
  Strict `json_schema` mode 400s on an empty answer and on a long multi-line body — it is right
  for the scorer's four integers and wrong for text (decisions 030, 032).
- **Never greet by a name the posting did not give.** `Hi <Company> team,` is the default and
  is fine; an invented first name in line one of a cold email is not. The GitHub rung was
  storing a *company* name in `contacts.name`, which is a person field (decision 033).
- **Drafting sets `reasoning_effort: 'low'`.** The thinking is billed inside `max_tokens`, not
  beside it: at the default this model spent 774 of 900 tokens reasoning and returned a
  truncated email (032).
- **The repo lives at `~/jobagent` and must never move under `~/Desktop`, `~/Documents` or
  `~/Downloads`.** macOS TCC grants Terminal access to those folders, not launchd, so the
  06:00 run dies at `exec` with `Operation not permitted` (exit 126) while every hand-run
  works perfectly. Measured 2026-08-13, decision 018.

## Docs

| File | Read it when |
|---|---|
| `docs/architecture.md` | Touching the data model, state machine, or a stage contract |
| `docs/phases.md` | Deciding what to build next; check status header first |
| `docs/agenthandoff.md` | **Start of every session** — in-flight work and blockers |
| `docs/decisions.md` | About to change a design choice; check it wasn't already settled |
| `SUMMARY.md` | Utkarsh asks what something is or does. Written for him, not for you — plain language, no jargon. Update it when the shape of the project changes, not for every commit |

## House style

- **Talk to Utkarsh in plain technical language.** Explain what we're doing and why,
  not the terminology for it. Real numbers and concrete comparisons help; jargon doesn't.
- Zod schema first, then the code that uses it. Never hand-write an interface that
  duplicates a schema.
- Each job source implements `JobSource` (`src/ingest/types.ts`). Adding a source =
  one new file, zero changes elsewhere.
- Docs point at code; they never restate it. If a fact lives in code, the doc links to it.
