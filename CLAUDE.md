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
- **Telegram** — plain `fetch` in `src/notify/telegram.ts`; sending is one POST. `grammy`
  arrives with Phase 3, which needs a long poll for approve/reject taps

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
node src/gmail/auth.ts                 # authorise Gmail (opens a browser, once)
node src/gmail/auth.ts --status        # which account, which scopes
node src/gmail/messages.ts --query="from:naukri.com" --links --full   # inspect real mail

./scripts/run-daily.sh                 # exactly what launchd runs at 06:00
node src/schedule/launchd.ts --status  # loaded? last exit code? how many runs?
node src/schedule/launchd.ts --install # (re)write and load the agent; --uninstall removes it
```

## Invariants — violating these causes real-world damage

1. **Never call `gmail.messages.send`.** Always `drafts.create` → store `gmail_draft_id`
   → `drafts.send(id)`. One code path for auto and approved. See `docs/architecture.md`.
2. **`outreach` has `UNIQUE(job_id)`.** Double-sending is structurally impossible. Keep it.
3. **Pattern-guessed emails never auto-send.** Only `confidence='high'` contacts
   (from the posting itself or a company team page) are eligible.
4. **Every stage is idempotent.** Re-running the pipeline twice must be a no-op.
   Rules per stage are in `docs/architecture.md`.
5. **Respect the daily send cap and the ramp.** Hard-coded, not configurable at runtime.
6. **State lives in SQLite, never in memory across stages.** A crash mid-run must be
   recoverable by just running again.

## Non-obvious facts

- **Never ask a model for a 0–100 score.** The scorer rates four factors 0–10 and
  `fitScore()` does the arithmetic. Asked for the number directly, the same posting came
  back 55, 78, 90 and 92 — and `REJECTED` is terminal. Decision 012.
- Groq is not reproducible even at `temperature: 0` — no seed, batched MoE. Design the
  variance out; do not retry it away.
- Groq model IDs are **verified against the live `/models` endpoint**, never hard-coded
  from memory. Its catalogue changes. Same rule that `data/companies.json` follows.
- Groq charges `prompt + max_tokens` at submission against an 8,000/min budget, so pacing is
  a token window (`src/llm/rate-limit.ts`), not a timer. Never raise `max_tokens` for
  "headroom" — it is billed whether used or not (decisions 013, 017).
- Sends are jittered 3–15 min apart starting 09:00. Never fire them all at pipeline time.
- LinkedIn/Naukri are ingested by parsing *my own Gmail job-alert emails*, never scraped.
  Alert postings therefore have **no description** — the scorer judges them on title,
  company and location alone (decision 016). Naukri's parser reads the URL *slug*, not the
  visible text, which truncates the company name.
- Contacts are cached per **company**, not per job. Assume the cache is warm.

## Docs

| File | Read it when |
|---|---|
| `docs/architecture.md` | Touching the data model, state machine, or a stage contract |
| `docs/phases.md` | Deciding what to build next; check status header first |
| `docs/agenthandoff.md` | **Start of every session** — in-flight work and blockers |
| `docs/decisions.md` | About to change a design choice; check it wasn't already settled |

## House style

- **Talk to Utkarsh in plain technical language.** Explain what we're doing and why,
  not the terminology for it. Real numbers and concrete comparisons help; jargon doesn't.
- Zod schema first, then the code that uses it. Never hand-write an interface that
  duplicates a schema.
- Each job source implements `JobSource` (`src/ingest/types.ts`). Adding a source =
  one new file, zero changes elsewhere.
- Docs point at code; they never restate it. If a fact lives in code, the doc links to it.
