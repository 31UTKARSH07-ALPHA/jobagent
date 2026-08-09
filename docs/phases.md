# Phases

> **Status: Phase 1 in progress. ATS ingest works end to end against 51 live boards;
> matching, scoring and the digest are not built yet.**
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
- [ ] `src/match/profile.ts` — resume PDF → typed profile via Opus **(needs the resume file)**
- [ ] `src/match/embed.ts` — bge-small + cosine prefilter
- [ ] `src/match/score.ts` — Haiku scorer with Zod structured output
- [ ] `src/notify/telegram.ts` — morning digest
- [x] `src/main.ts` — stage runner + `--stage` / `--dry-run` flags *(done in Phase 0;
      stages just need real implementations plugged into `STAGES`)*

**Done when:** a real Telegram digest arrives from a real cron run.

### Calibration gate — do not skip

Run **scoring only for 3 days**, then look at the actual score distribution before
setting thresholds. The `70` / `85` values in `architecture.md` are guesses. Record the
real numbers in `decisions.md` when you set them.

---

## Phase 2 — Contacts and drafts

- [ ] `src/contacts/cascade.ts` — posting metadata → team page → GitHub → pattern
- [ ] `src/contacts/verify.ts` — MX check via `dns/promises`
- [ ] Confidence assignment (see `CLAUDE.md` invariant 3)
- [ ] `src/draft/compose.ts` — Opus drafting, uses `job_scores.hook`
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
- Batch API for scoring (only if volume grows ~10×)
- Reply classification → auto-schedule interview prep
