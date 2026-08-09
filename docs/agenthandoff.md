# Agent handoff

Session-boundary state. **Read this first, update it last.**

This file answers "what was happening when the last session ended" — the things that are
*not* recoverable from code or git. It is intentionally short and intentionally volatile:
delete anything that has become false rather than keeping a history. History belongs in
`decisions.md` and `git log`.

Do not restate architecture here. Point at `docs/architecture.md`.

---

## Now

Phase 0 done. The ATS half of Phase 1 ingest is done and runs against real boards:
`node src/main.ts --stage=ingest` polls 51 verified boards, applies the title and
geography filters, and writes `jobs` + `companies`. Second run in a row discovers 0 new
rows — idempotency holds. 34 tests green, `tsc --noEmit` clean.

**The number that matters: 4,710 postings seen → 5 kept.** That is not a bug (4,693 are
senior or non-engineering, 10 are foreign-onsite), but it does mean the ATS pollers alone
will not fill a daily digest. See the coverage note below.

## In flight

Nothing. Clean tree, no partial work.

## Coverage problem worth understanding before building more

102 of 153 hand-picked candidate companies have **no board on Greenhouse/Lever/Ashby/
Workable** — including nearly every large Indian company (Zomato, Swiggy, Flipkart,
Zerodha, Razorpay, Freshworks, Zoho). They run their own portals, Workday or Darwinbox.

So the 51 verified boards skew global/remote, and Indian coverage has to come from
`src/ingest/gmail-alerts.ts`. That moves Gmail OAuth from "nice to have" to **the**
blocker for a useful digest. Full reasoning in `docs/decisions.md` 010.

## Blocked on Utkarsh

1. **Google Cloud OAuth** — now the top blocker, not the third. Needs his browser,
   ~10 min. Create project → enable Gmail API → OAuth consent screen (External, testing,
   add his own email as a test user) → create Desktop app credentials → download as
   `credentials.json` into the project root. Scopes: `gmail.readonly`, `gmail.compose`,
   `gmail.send`.
2. **Telegram bot token** — talk to `@BotFather`, `/newbot`, paste the token into `.env`.

*(Resume and Groq key are both done — `GROQ_API_KEY` is in `.env`, and
`data/profile.json` is extracted and verified against the PDF.)*

*(Target geography is settled — India + remote-global, decision 009.)*

## Next action

Either is unblocked and useful:

- `src/match/score.ts` — fully unblocked. `src/llm/groq.ts` + `complete()` handle the
  structured output, `loadProfile()` gives the profile. Works on the 5 real rows in the DB.
- `src/match/embed.ts` — bge-small prefilter. Needs no key at all, but installs
  `@huggingface/transformers` (~500MB of ONNX runtime). At 5 jobs/day the prefilter is
  not yet earning its keep — scoring everything is cheaper. Revisit when ingest volume
  grows, i.e. after Gmail alerts land.
- More ATS coverage — add names to `src/ingest/candidates.ts`, run
  `node src/ingest/refresh-companies.ts`. It only *adds* verified boards; a company is
  removed only when a probe confirms it is gone, never when a probe errors.

Deps installed so far: `zod`, `unpdf`, `typescript`, `@types/node`. No LLM SDK — Groq
speaks the OpenAI chat shape, so `src/llm/groq.ts` is plain `fetch`. The rest
(`googleapis`, `@huggingface/transformers`, `grammy`) gets installed when the stage that
needs it is written, not before.

**Measured, and the reason `complete()` retries:** `gpt-oss-120b` failed to produce
schema-valid JSON on roughly one call in four, then succeeded three times running on the
identical prompt. It is a dice roll, not a capability gap — do not "fix" it by changing
models or loosening the schema.

## Context not captured in code

- Send mode decided: **hybrid** — auto-send only when `confidence='high'` AND
  `fit_score > 85`; everything else queues for approval.
- Budget: **free tiers only**. No paid contact APIs. Anthropic API (~$7/mo) is the one
  accepted cost.
- Thresholds `70` / `85` are placeholders pending the Phase 1 calibration gate.

## Open questions not yet settled

- Daily send cap: architecture says ramp to 8/day; original ask was 10–20. Not resolved.
- Follow-ups: one at day 4, or none in v1?
- Suppression: second role at an already-emailed company — approval queue, or skip?

---

### How to update this file

At the end of a working session, rewrite `Now`, `In flight`, and `Next action`. Move
anything *decided* into `decisions.md` and delete it from here. If this file grows past
one screen, it has become a log — trim it.
