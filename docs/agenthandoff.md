# Agent handoff

Session-boundary state. **Read this first, update it last.**

This file answers "what was happening when the last session ended" — the things that are
*not* recoverable from code or git. It is intentionally short and intentionally volatile:
delete anything that has become false rather than keeping a history. History belongs in
`decisions.md` and `git log`.

Do not restate architecture here. Point at `docs/architecture.md`.

---

## Now

Phase 0 complete. Phase 1: ingest → score → **Telegram digest** works for real, and a real
digest has landed on Utkarsh's phone. 72 tests green, `tsc --noEmit` clean, working tree
clean, all pushed.

| Works today | Command |
|---|---|
| ATS ingest across 51 verified boards | `node src/main.ts --stage=ingest` |
| Re-verify / extend the board list | `node src/ingest/refresh-companies.ts` |
| Resume → `data/profile.json` | `node src/match/profile.ts --resume=<pdf>` |
| **Scoring → MATCHED / REJECTED** | `node src/main.ts --stage=score` |
| **One job, printed, nothing written** | `node src/match/score.ts --job=<id>` |
| **The calibration histogram** | `node src/match/score.ts --distribution` |
| **Send the morning digest** | `node src/main.ts --stage=digest` |
| **Preview it without sending** | `node src/main.ts --stage=digest --dry-run` |
| **Prove the bot works** | `node src/notify/telegram.ts --test` |
| Any model call | `complete()` / `chat()` in `src/llm/groq.ts` |

All 5 DISCOVERED rows are now scored under rubric v2: **100, 86, 76, 46, 30** → 3 MATCHED,
2 REJECTED. Sane at both ends — Stripe's SWE intern is the 100; a Linux *kernel* role got
stack 0 / domain 0 and a Cloudflare intern role that is onsite in Austin got location 0.

Telegram is fully wired: bot `@utkarsh_jobagent_bot`, token and `TELEGRAM_CHAT_ID` both in
`.env`. `credentials.json` for Gmail is in the project root (Desktop-app client, project
`jobagent-505021`) but **no OAuth code exists yet and `token.json` has never been written**.

Not built yet: contacts, drafting, sending, Gmail-alert ingest. `src/main.ts` still logs
those stages as no-ops.

**The number that still matters: 4,710 postings seen → 5 kept.** The ATS pollers alone will
never fill a daily digest. See the coverage note below.

## In flight

Nothing. Clean tree, no partial work.

## Read decisions 012, 013 and 014 before touching the scorer or the digest

Three things a fresh session would otherwise undo, all measured on 2026-08-10:

- **Never ask a model for a 0–100 score.** Asked directly, the same posting came back 55,
  78, 90 and 92 — and `REJECTED` is terminal, so a bad roll silently discards a good job.
  The model now rates four factors 0–10 and `fitScore()` does the arithmetic, with two hard
  gates (`level_fit` or `location_fit` ≤ 1 caps the total at 30). Spread on the same
  posting fell to 86/77/86. `temperature: 0` alone did *not* fix it — Groq has no seed.
- **The free tier is 8,000 tokens/min and Groq charges prompt + `max_tokens`.** That is two
  scoring calls a minute, ~30s per job. Hence `MAX_SCORES_PER_RUN = 60`, and hence the 429
  wait is parsed out of the error body. Do not raise `max_tokens` for "headroom" — it is
  charged whether it is used or not.
- **The digest is silent when nothing matched, and that is deliberate** (014). It is also
  HTML rather than MarkdownV2, because job titles are full of the fifteen characters
  MarkdownV2 makes you escape. Do not "add a daily status ping" here — a dead cron is the
  launchd layer's problem, and a usually-empty message is one you stop reading.

## Coverage problem worth understanding before building more

102 of 153 hand-picked candidate companies have **no board on Greenhouse/Lever/Ashby/
Workable** — including nearly every large Indian company (Zomato, Swiggy, Flipkart,
Zerodha, Razorpay, Freshworks, Zoho). They run their own portals, Workday or Darwinbox.

So the 51 verified boards skew global/remote, and Indian coverage has to come from
`src/ingest/gmail-alerts.ts`. That makes Gmail OAuth **the** blocker for a useful digest.
Full reasoning in `docs/decisions.md` 010.

## Blocked on Utkarsh

**Nothing.** Resume, Groq key, Telegram bot and `credentials.json` are all in place as of
2026-08-10. The only thing he still has to do is click through one OAuth consent screen when
the Gmail flow is written — and that cannot happen before the code exists.

*(Target geography is settled — decision 009.)*

## Next action

**Gmail OAuth, then `src/ingest/gmail-alerts.ts`.** `credentials.json` is already in place,
so the remaining work is code plus one browser approval: an installed-app OAuth flow writing
`token.json`, then a `JobSource` that parses LinkedIn and Naukri alert emails. This is the
real unlock — see the coverage note. Scopes: `gmail.readonly`, `gmail.compose`, `gmail.send`.

Worth knowing before it bites: the consent screen is in **Testing** mode, so its refresh
token expires after 7 days. Either publish the app or plan on re-approving weekly.

Then, in order of value:

- **A launchd plist for the 06:00 run** — the last thing between "works when run" and
  "arrives each morning". Not yet written; Utkarsh has not been asked whether he wants a
  background agent installed.
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

- Does Utkarsh want a launchd agent installed on this laptop, or would he rather run the
  pipeline by hand until it has proved itself? Not asked yet.
- Daily send cap: architecture says ramp to 8/day; original ask was 10–20. Not resolved.
- Follow-ups: one at day 4, or none in v1?
- Suppression: second role at an already-emailed company — approval queue, or skip?

---

### How to update this file

At the end of a working session, rewrite `Now`, `In flight`, and `Next action`. Move
anything *decided* into `decisions.md` and delete it from here. If this file grows past
one screen, it has become a log — trim it.
