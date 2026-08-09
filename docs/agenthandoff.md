# Agent handoff

Session-boundary state. **Read this first, update it last.**

This file answers "what was happening when the last session ended" — the things that are
*not* recoverable from code or git. It is intentionally short and intentionally volatile:
delete anything that has become false rather than keeping a history. History belongs in
`decisions.md` and `git log`.

Do not restate architecture here. Point at `docs/architecture.md`.

---

## Now

Phase 0 done and committed. `npm run dry-run` creates `data/jobagent.db`, walks all six
daily stages as logged no-ops, and exits 0. `node --test` is 9 green. `npx tsc --noEmit`
is clean.

The stage runner (`src/main.ts`) already has the `--stage` / `--dry-run` plumbing and a
`STAGES` registry — Phase 1 is filling in real `run()` bodies, not restructuring.

## In flight

Nothing. Clean tree, no partial work.

## Blocked on Utkarsh

1. **Resume file** — needed for `src/match/profile.ts`. PDF or text, any path he names.
2. **Google Cloud OAuth** — needs his browser, ~10 min. Create project → enable Gmail
   API → OAuth consent screen (External, testing, add his own email as a test user) →
   create Desktop app credentials → download as `credentials.json` into the project root.
   Scopes: `gmail.readonly`, `gmail.compose`, `gmail.send`.
3. **Telegram bot token** — talk to `@BotFather`, `/newbot`, paste the token into `.env`.
4. **Target geography** — still unanswered. Only blocks the `data/companies.json` seed
   list, nothing else. India / remote-global / US-Europe, multi-select.

## Next action

`src/ingest/types.ts` then `src/ingest/ats.ts` — the ATS pollers need none of the
blockers above and produce real rows immediately. `RawJob` (what an adapter emits) is
already defined in `src/store/schema.ts`.

Only deps installed so far are `zod` + `typescript`/`@types/node`. The rest of the stack
(`@anthropic-ai/sdk`, `googleapis`, `@huggingface/transformers`, `grammy`) gets installed
when the stage that needs it is written, not before.

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
