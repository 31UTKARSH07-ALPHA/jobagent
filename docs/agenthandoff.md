# Agent handoff

Session-boundary state. **Read this first, update it last.**

This file answers "what was happening when the last session ended" — the things that are
*not* recoverable from code or git. It is intentionally short and intentionally volatile:
delete anything that has become false rather than keeping a history. History belongs in
`decisions.md` and `git log`.

Do not restate architecture here. Point at `docs/architecture.md`.

---

## Now

Phase 0 complete. Phase 1 is functionally done: **boards + Naukri alert email → score →
Telegram digest**, all against real data. 126 tests green, `tsc --noEmit` clean, working tree
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
| **Gmail status** | `node src/gmail/auth.ts --status` |
| **Inspect real alert mail** | `node src/gmail/messages.ts --query="from:naukri.com" --links --full` |
| **Re-score after a rubric bump** | `node src/match/score.ts --rescore` |
| Any model call | `complete()` / `chat()` in `src/llm/groq.ts` |

**Gmail is live.** Authorised as `3107utkarshpathak@gmail.com` (`token.json`, mode 600),
scopes readonly + compose + send. Telegram bot `@utkarsh_jobagent_bot`, token and chat id in
`.env`. Utkarsh forwards LinkedIn and Naukri mail into that mailbox with Gmail *filters* —
note that Gmail's "Disable forwarding" radio only governs blanket forwarding, so a filter
forwards regardless of what that radio says.

9 jobs in the DB, 6 MATCHED / 3 REJECTED, 3 of them from Naukri alert email. Rubric is now
**v3** — see the clamp note below for why v2's numbers should be ignored.

**LinkedIn has sent nothing, ever.** Zero messages in 45 days, so there is no LinkedIn parser
and writing one now would mean guessing at bulk-mail HTML. Utkarsh needs to confirm he has
actual **job alerts created on LinkedIn** (Jobs → Job Alerts); a filter cannot forward mail
that is never sent, and filters never act retroactively. Such mail is fetched and counted as
`alert_unparsed` so the day it arrives is visible in `runs.stats`.

Not built yet: contacts, drafting, sending. `src/main.ts` still logs those stages as no-ops.

## In flight

Nothing. Clean tree, no partial work.

## Read decisions 012–016 before touching the scorer, the digest or the parsers

Things a fresh session would otherwise undo, all measured rather than assumed:

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
- **A posting with no description is clamped to 82 max** (016). Alert emails carry no JD, and
  on the first real run all three Naukri jobs came back 10/10/10/10 → 100, tying Stripe's
  internship, which had a full JD confirming the match. With nothing to deduct against,
  nothing gets deducted. `clampToEvidence()` holds `stack_fit`/`domain_fit` to 6, which caps
  the total below the 85 Phase 3 needs to auto-send: a posting nobody has read cannot mail
  itself. Do not remove the clamp to "let good jobs score higher".
- **Naukri's parser reads the URL slug, not the visible text** (016) — the rendered email
  truncates the company to "Discover Dollar Tec…". Re-verify with the `messages.ts` CLI above
  if it ever returns nothing; the failure mode is silence, not an error.
- **The digest takes each job's newest score, never a pinned `PROMPT_VERSION`.** Pinning
  looked tidier and dropped already-matched-but-unreported jobs from the digest forever on
  the first rubric bump.

## Coverage problem worth understanding before building more

102 of 153 hand-picked candidate companies have **no board on Greenhouse/Lever/Ashby/
Workable** — including nearly every large Indian company (Zomato, Swiggy, Flipkart,
Zerodha, Razorpay, Freshworks, Zoho). They run their own portals, Workday or Darwinbox.

So the 51 verified boards skew global/remote, and Indian coverage has to come from
`src/ingest/gmail-alerts.ts`. That makes Gmail OAuth **the** blocker for a useful digest.
Full reasoning in `docs/decisions.md` 010.

## Blocked on Utkarsh

Every credential is in place — resume, Groq key, Telegram bot, Gmail OAuth (authorised
2026-08-11). Two things only he can settle:

1. **Create job alerts on LinkedIn** (Jobs → Job Alerts), or confirm that he has. LinkedIn has
   sent nothing in 45 days, and no forwarding filter can forward mail that is never sent. Until
   then there is no LinkedIn parser, because there is nothing to write one against.
2. **Decide whether to publish the OAuth consent screen.** In Testing mode the refresh token
   expires every 7 days, which an unattended 06:00 run cannot survive. Publishing removes it;
   the alternative is re-running `node src/gmail/auth.ts` weekly.

*(Target geography is settled — decision 009.)*

## Next action

**A launchd plist for the 06:00 run.** Everything works when run by hand; nothing runs on its
own. That is the last thing standing between Phase 1 and "a digest arrives each morning", and
it is the thing Utkarsh actually asked for. He has *not* been asked whether he wants a
background agent installed on this laptop — ask first.

The token expiry matters here: the consent screen is in **Testing**, so the refresh token dies
every 7 days and an unattended 06:00 run will fail with `invalid_grant` (explained in full by
`describeAuthError`). Either publish the consent screen or expect to re-run
`node src/gmail/auth.ts` weekly. Worth resolving *before* trusting a schedule.

Then, in order of value:

- **The LinkedIn parser** — but only once real LinkedIn mail exists. Watch `alert_unparsed` in
  `runs.stats.ingest`; when it is non-zero, `node src/gmail/messages.ts --query="from:linkedin.com"
  --links --full` gives the payload to write it against. Add it to `PARSERS` in
  `src/ingest/gmail-alerts.ts` — one entry, nothing else changes.
- Let scoring run 3 days, then `--distribution` and set the thresholds for real
  (decision 008). **Split the numbers by source** — ATS postings have a full JD and alert
  postings have none, so one threshold across both compares unlike things.
- Phase 2's contact cascade has a new first job: `resolveCompany` returns
  `.unknown.invalid` for nearly every Naukri company (3 of 3 on the first run), because they
  are small firms absent from `candidates.ts`. The cascade must *find* a domain from a name,
  not assume one exists.

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
  reset, not something any stage may do. **`--rescore` now exists so that never needs doing
  again**: it writes a score at the current `PROMPT_VERSION` for any job missing one, without
  touching state, and prints the jobs whose state no longer agrees with their score.
- v1 and v2 score rows are in the DB and should be ignored for calibration. v1 was scored at
  temperature 1.0 (decision 012); v2 predates the title-only clamp (016).

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
