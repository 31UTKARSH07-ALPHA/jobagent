# Phases

> **Status: Phase 1 nearly done. Ingest → score → Telegram digest works end to end, and a
> real digest has landed on Utkarsh's phone. Left: Gmail-alert ingest (where Indian coverage
> has to come from) and a launchd schedule so it runs without being asked.**
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
- [ ] Gmail OAuth flow → `token.json` **(needs Utkarsh in a browser, ~10 min)**
- [ ] `src/ingest/gmail-alerts.ts` — parse LinkedIn + Naukri alert emails
      **← higher priority than it looks: the big Indian companies are not on any
      supported ATS, so this is where Indian coverage actually comes from (decision 010)**
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

**Done when:** a real Telegram digest arrives from a real cron run.

A real digest has arrived — 3 matches, sent to Utkarsh's phone on 2026-08-10 — but from a
hand-run `--stage=digest`, not from a schedule. What is left for Phase 1: Gmail-alert ingest
(the coverage problem, decision 010) and a launchd plist for the 06:00 run.

### Calibration gate — do not skip

Run **scoring only for 3 days**, then look at the actual score distribution before
setting thresholds: `node src/match/score.ts --distribution`. The `70` / `85` values are
guesses. Record the real numbers in `decisions.md` when you set them.

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
- [ ] launchd plists for both schedules

**Ramp is mandatory:** 3/day week 1 → 5/day week 2 → 8/day week 3. Do not start at 8.

**Done when:** it has run unattended for a week without a bounce or a bad send.

---

## Later, only if the earlier phases prove themselves

- Own domain + Google Workspace + SPF/DKIM/DMARC (before volume goes up)
- Move off the laptop: GitHub Actions or a $5 VPS
- More sources: HN Who-is-Hiring, Adzuna, Remotive, Wellfound
- Move drafting to `claude-opus-5` (~$3.75/mo) if reply rates disappoint — decision 011
- Reply classification → auto-schedule interview prep
