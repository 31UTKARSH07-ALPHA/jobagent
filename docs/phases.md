# Phases

> **Status: Phase 1 complete.** The 2026-08-14 06:11 run was scheduled, unattended, and put 3
> matches on Utkarsh's phone. Since then: the 06:00 network gate (019), because three days of
> runs found nothing while Wi-Fi was still asleep, and the LinkedIn parser (020), because 26
> real digests finally arrived — alert postings went 6 → 67 in a run. 30 jobs are scored on the
> next run. **Next: the calibration gate (008), which needed exactly this volume.** Phase 2
> (contacts, drafts) is unblocked and unstarted.
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
- [x] `src/ingest/gmail-alerts.ts` — alert emails as a `JobSource`. **Naukri parses**
      (`src/ingest/naukri-alert.ts`, written against real mail). **LinkedIn does not yet
      exist** — no LinkedIn alert has ever arrived in the mailbox to write it against;
      such mail is fetched and counted as `alert_unparsed` so its arrival is visible
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

**Done when:** a real Telegram digest arrives from a real cron run.

A real digest has arrived — 3 matches, sent to Utkarsh's phone on 2026-08-10 — but from a
hand-run `--stage=digest`. The agent fired for the first time on 2026-08-13 and failed on
macOS TCC before running a line (018a); from `~/jobagent` it now runs clean under launchd, so
the next unattended run is **2026-08-14 06:00**. What is left for Phase 1:

1. **Done** — the 2026-08-14 06:11 run reported 3 matches unattended.
   (`last exit code = 0`) and a full run in `logs/daily.log`. Nothing else ticks this box.
2. **The LinkedIn alert parser**, once there is a real LinkedIn *digest* to write it against.
   Alerts were created 2026-08-12 and the "alert has been created" confirmation arrived, which
   proves the alert and the forwarding filter both work — but a confirmation carries no job
   listings. Watch `alert_unparsed` in `runs.stats.ingest`. Not a guess-and-hope job:
   bulk-mail HTML written blind produces a parser that passes its own tests and reads nothing.

### Calibration gate — do not skip

Run **scoring only for 3 days**, then look at the actual score distribution before
setting thresholds: `node src/match/score.ts --distribution`. The `70` / `85` values are
guesses. Record the real numbers in `decisions.md` when you set them.

**Split the distribution by source.** ATS postings arrive with a full job description; alert
postings arrive with a title and nothing else (decision 016), so the same rubric is working
from two very different amounts of evidence. One threshold across both compares unlike things.

Two knobs, not one. If the distribution is wrong-shaped rather than merely shifted, the
factor weights in `src/match/score.ts` are the thing to change, not `MATCH_THRESHOLD` —
the stored per-factor ratings say which factor is doing it. Bump `PROMPT_VERSION` when you
change either the prompt or the weights, so the old distribution survives for comparison.

---

## Phase 2 — Contacts and drafts

- [ ] `src/contacts/cascade.ts` — posting metadata → team page → GitHub → pattern
- [ ] `src/contacts/verify.ts` — MX check via `dns/promises`
- [ ] Confidence assignment (see `CLAUDE.md` invariant 3)
- [ ] `src/draft/compose.ts` — drafting, uses `job_scores.hook`
- [ ] Write drafts into Gmail; nothing sends yet
- [ ] Digest shows drafts inline for review

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
