# Agent handoff

Session-boundary state. **Read this first, update it last.**

This file answers "what was happening when the last session ended" — the things that are
*not* recoverable from code or git. It is intentionally short and intentionally volatile:
delete anything that has become false rather than keeping a history. History belongs in
`decisions.md` and `git log`.

Do not restate architecture here. Point at `docs/architecture.md`.

---

## Now

Phase 0 complete. Phase 1: ingest and scoring both work for real. 61 tests green,
`tsc --noEmit` clean, working tree clean, all pushed.

| Works today | Command |
|---|---|
| ATS ingest across 51 verified boards | `node src/main.ts --stage=ingest` |
| Re-verify / extend the board list | `node src/ingest/refresh-companies.ts` |
| Resume → `data/profile.json` | `node src/match/profile.ts --resume=<pdf>` |
| **Scoring → MATCHED / REJECTED** | `node src/main.ts --stage=score` |
| **One job, printed, nothing written** | `node src/match/score.ts --job=<id>` |
| **The calibration histogram** | `node src/match/score.ts --distribution` |
| Any model call | `complete()` / `chat()` in `src/llm/groq.ts` |

All 5 DISCOVERED rows are now scored under rubric v2: **100, 86, 76, 46, 30** → 3 MATCHED,
2 REJECTED. Sane at both ends — Stripe's SWE intern is the 100; a Linux *kernel* role got
stack 0 / domain 0 and a Cloudflare intern role that is onsite in Austin got location 0.

Not built yet: the Telegram digest, contacts, drafting, sending. `src/main.ts` still logs
those stages as no-ops.

**The number that still matters: 4,710 postings seen → 5 kept.** The ATS pollers alone will
never fill a daily digest. See the coverage note below.

## In flight

Nothing. Clean tree, no partial work.

## Read decisions 012 and 013 before touching the scorer

They are the two things a fresh session would otherwise undo, both measured today:

- **Never ask a model for a 0–100 score.** Asked directly, the same posting came back 55,
  78, 90 and 92 — and `REJECTED` is terminal, so a bad roll silently discards a good job.
  The model now rates four factors 0–10 and `fitScore()` does the arithmetic, with two hard
  gates (`level_fit` or `location_fit` ≤ 1 caps the total at 30). Spread on the same
  posting fell to 86/77/86. `temperature: 0` alone did *not* fix it — Groq has no seed.
- **The free tier is 8,000 tokens/min and Groq charges prompt + `max_tokens`.** That is two
  scoring calls a minute, ~30s per job. Hence `MAX_SCORES_PER_RUN = 60`, and hence the 429
  wait is parsed out of the error body. Do not raise `max_tokens` for "headroom" — it is
  charged whether it is used or not.

## Coverage problem worth understanding before building more

102 of 153 hand-picked candidate companies have **no board on Greenhouse/Lever/Ashby/
Workable** — including nearly every large Indian company (Zomato, Swiggy, Flipkart,
Zerodha, Razorpay, Freshworks, Zoho). They run their own portals, Workday or Darwinbox.

So the 51 verified boards skew global/remote, and Indian coverage has to come from
`src/ingest/gmail-alerts.ts`. That makes Gmail OAuth **the** blocker for a useful digest.
Full reasoning in `docs/decisions.md` 010.

## Blocked on Utkarsh

1. **Google Cloud OAuth** — the top blocker. Needs his browser, ~10 min. Create project →
   enable Gmail API → OAuth consent screen (External, testing, add his own email as a test
   user) → create Desktop app credentials → download as `credentials.json` into the project
   root. Scopes: `gmail.readonly`, `gmail.compose`, `gmail.send`.
2. **Telegram bot token** — talk to `@BotFather`, `/newbot`, paste the token into `.env`.

*(Resume and Groq key are both done. Target geography is settled — decision 009.)*

## Next action

**`src/notify/telegram.ts`.** Everything it needs now exists: 3 MATCHED jobs with a
`fit_score`, a `reasoning` and a `hook` each, plus `factorLine()` for the one-line
breakdown. Needs the bot token above; until then it can be built and tested against a
fixture. That closes Phase 1 — a digest actually arriving each morning.

Then, in order of value:

- **Gmail OAuth + `src/ingest/gmail-alerts.ts`** — the real unlock. See the coverage note.
- Let scoring run 3 days, then `--distribution` and set the thresholds for real
  (decision 008). With 5 scores the histogram means nothing yet.

Deliberately deferred:
- `src/match/embed.ts` — bge-small prefilter. At 5 jobs/day scoring everything is cheaper
  than installing ~500MB of ONNX runtime. Revisit after Gmail alerts land; the TPM ceiling
  in decision 013 is what will make a prefilter start earning its keep.
- More ATS coverage — add names to `src/ingest/candidates.ts`, run
  `node src/ingest/refresh-companies.ts`. It only *adds* verified boards; a company is
  removed only when a probe confirms it is gone, never when a probe errors.

Deps installed so far: `zod`, `unpdf`, `typescript`, `@types/node`. No LLM SDK — Groq
speaks the OpenAI chat shape, so `src/llm/groq.ts` is plain `fetch`. The rest (`googleapis`,
`@huggingface/transformers`, `grammy`) gets installed when the stage that needs it is
written, not before.

## Context not captured in code

- Send mode decided: **hybrid** — auto-send only when `confidence='high'` AND
  `fit_score > 85`; everything else queues for approval.
- Budget: **free tiers only, and literally $0** (decision 011). The escape hatch if drafts
  get ignored is drafting-only → `claude-opus-5`, ~$3.75/mo, one file.
- Thresholds `70` / `85` are placeholders pending the calibration gate. The factor weights
  in `src/match/score.ts` are the *other* knob — reasoned, not measured.
- `data/jobagent.db` had its 5 jobs reset to `DISCOVERED` by hand once, on 2026-08-10, so
  they could be re-scored under rubric v2 after migration 002 discarded the v1 scores.
  `REJECTED` is terminal, so the state machine has no path back — that was a one-off dev
  reset, not something any stage may do.

## Open questions not yet settled

- Daily send cap: architecture says ramp to 8/day; original ask was 10–20. Not resolved.
- Follow-ups: one at day 4, or none in v1?
- Suppression: second role at an already-emailed company — approval queue, or skip?

---

### How to update this file

At the end of a working session, rewrite `Now`, `In flight`, and `Next action`. Move
anything *decided* into `decisions.md` and delete it from here. If this file grows past
one screen, it has become a log — trim it.
