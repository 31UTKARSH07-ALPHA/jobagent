# Phases

> **Status: Phase 2 code is complete and has run for real; it has not yet run unattended.**
> 2026-08-25: 67 matched jobs have a verified domain and a contact, 8 real drafts sit in Gmail,
> 264 tests. The pipeline now goes ingest → score → contacts → draft → digest end to end.
> **What is not yet known is whether the drafts are any good** — that is Phase 2's actual
> done-when, and it needs Utkarsh to read them. Nothing sends: `drafts.send` does not exist
> outside Phase 3. Decisions 030–032 cover the work; `agenthandoff.md` has the state.
> Update this header every time a phase completes. It is the first thing read each session.

Ship each phase end-to-end before starting the next. A working Phase 1 already removes
most of the daily pain; Phases 2–3 are amplifiers, not prerequisites.

---

## Phase 0 — Scaffold

- [x] Project directory + git
- [x] `CLAUDE.md`, `docs/architecture.md`, `docs/phases.md`, `docs/agenthandoff.md`, `docs/decisions.md`
- [x] `package.json` (`type: module`), `tsconfig.json` (`erasableSyntaxOnly`)
- [x] `src/store/schema.ts` — Zod schemas for every table
- [x] `src/store/db.ts` — `node:sqlite` connection + migrations
- [x] `src/store/state.ts` — the state machine, single place transitions are legal
- [x] `.env.example` + `.gitignore` (must exclude `data/`, `.env`, `credentials.json`, `token.json`)
- [x] `src/main.ts` — stage runner skeleton, every stage a logged no-op
- [x] `src/store/state.test.ts` — transitions, terminality, guarded updates

**Done when:** `node src/main.ts --dry-run` runs, creates the DB, and exits clean. ✅

---

## Phase 1 — A daily digest that is actually useful

The goal is a Telegram message every morning listing ~10 well-matched roles. No emails
yet. This alone replaces the manual searching.

- [x] `src/ingest/types.ts` — the `JobSource` interface
- [x] `src/ingest/ats.ts` — Greenhouse, Lever, Ashby, Workable pollers
- [x] `data/companies.json` — generated and verified by `src/ingest/refresh-companies.ts`,
      not hand-written (decision 010). Add companies in `src/ingest/candidates.ts`.
- [x] Gmail OAuth flow → `token.json` — `src/gmail/auth.ts`, loopback + PKCE (decision 015)
- [x] `src/gmail/messages.ts` — search, MIME flattening, link extraction
- [x] `src/ingest/gmail-alerts.ts` — alert emails as a `JobSource`. **Naukri**
      (`naukri-alert.ts`, 2026-08-11) and **LinkedIn** (`linkedin-alert.ts`, 2026-08-16),
      both written against real mail. Unknown senders are counted as `alert_unparsed`,
      which is how LinkedIn's arrival became visible in the first place
- [x] `src/ingest/resolve-company.ts` — company name → domain, for sources that only
      give a display name
- [x] `src/match/profile.ts` — resume PDF → typed profile (`unpdf` + Groq)
- [ ] `src/match/embed.ts` — bge-small + cosine prefilter
- [x] `src/llm/` — Groq client + one interface per job (decision 011) 
- [x] `src/match/score.ts` — four factor ratings from the model, score computed in code
      (decision 012). `--distribution` prints the histogram the calibration gate needs.
- [x] `src/notify/telegram.ts` — send-only Telegram client (`--chat-id`, `--test`)
- [x] `src/notify/digest.ts` — the morning digest stage. Reported once per job via
      `jobs.digested_at`; silent when nothing new (decision 014)
- [x] `src/main.ts` — stage runner + `--stage` / `--dry-run` flags *(done in Phase 0;
      stages just need real implementations plugged into `STAGES`)*
- [x] `scripts/run-daily.sh` + `src/schedule/launchd.ts` — the 06:00 schedule. The plist is
      generated from the running process, never committed (decision 018) 

**Done when:** a real Telegram digest arrives from a real cron run. ✅ **2026-08-14 06:11** —
scheduled, unattended, exit 0, 3 matches reported.

Two things were learned in the three days after, and both are the reason the box took a week
longer than "the code works" suggested:

- A scheduled run can be **green and useless**. 08-14 and 08-15 both exited 0 having found
  nothing, because Wi-Fi was still asleep (019). Exit code is not evidence of work.
- The digest's silence (014) means **the logs are the only place a dead morning shows up**.
  That is still the right default, but it changes where to look.

### Calibration gate — done 2026-08-20 (decision 024)

`MATCH_THRESHOLD = 70` is now measured rather than guessed: it rejects the right band
("Intern Engineer", "Trainee engineer", GSK's "Intern Bios Programming") and keeps the right
one (Sony Research India, Sanas, Freight Tiger, Enterpret). 024 also records what is still
wrong — a 22-way tie at the 84 ceiling, false negatives on bare-but-real titles like CoinDCX's
"Intern - Engineering", and no company signal in the rubric at all. Re-check the threshold
against v5 rather than assuming it carries over.

**Split the distribution by source.** ATS postings arrive with a full job description; alert
postings arrive with a title and nothing else (decision 016), so the same rubric is working
from two very different amounts of evidence. One threshold across both compares unlike things.

Two knobs, not one. If the distribution is wrong-shaped rather than merely shifted, the
factor weights in `src/match/score.ts` are the thing to change, not `MATCH_THRESHOLD` —
the stored per-factor ratings say which factor is doing it. Bump `PROMPT_VERSION` when you
change either the prompt or the weights, so the old distribution survives for comparison.

---

## Phase 2 — Contacts and drafts

- [x] `src/contacts/domain.ts` — company **name** → a verified domain. Not in the original
      plan and unavoidable: 73 of the 78 matched jobs were on `.unknown.invalid` markers, and
      every rung below keys off a domain (decision 030)
- [x] `src/contacts/cascade.ts` — posting metadata → team page → GitHub → pattern
- [x] `src/contacts/verify.ts` — MX check via `dns/promises`
- [x] Confidence assignment (see `CLAUDE.md` invariant 3)
- [x] `src/contacts/index.ts` — the stage: per company, per-company budget, 3-day retry
- [x] `src/draft/compose.ts` — drafting, uses `job_scores.hook`. Plain text, not structured
      output, and `reasoning_effort: 'low'` — decision 032 has the measurements
- [x] `src/draft/gmail-draft.ts` — `drafts.create` only; nothing sends yet
- [x] Digest shows drafts inline for review, plus a section for drafts whose match was
      reported on an earlier morning (migration 005)

**Done when:** you read ~5 drafts each morning and would genuinely send 3 of them.

---

## Phase 3 — Sending

- [ ] `src/send/gate.ts` — auto vs approval, daily cap, ramp, suppression
- [ ] `src/send/queue.ts` — jittered 09:00 scheduler
- [ ] Telegram approve/reject buttons wired to state transitions
- [ ] `src/track/replies.ts` — reply + bounce detection, every 4h
- [ ] Follow-up scheduler (day 4, once)
- [ ] The 4-hourly tracker schedule — a second `LaunchdJob` in `src/schedule/launchd.ts`,
      `StartInterval` rather than a calendar entry (decision 018)

**Ramp is mandatory:** 3/day week 1 → 5/day week 2 → 8/day week 3. Do not start at 8.

**Done when:** it has run unattended for a week without a bounce or a bad send.

---

## Later, only if the earlier phases prove themselves

- Own domain + Google Workspace + SPF/DKIM/DMARC (before volume goes up)
- Move off the laptop: GitHub Actions or a $5 VPS
- More sources: HN Who-is-Hiring, Adzuna, Remotive, Wellfound
- Move drafting to `claude-opus-5` (~$3.75/mo) if reply rates disappoint — decision 011
- Reply classification → auto-schedule interview prep
