# Agent handoff

Session-boundary state. **Read this first, update it last.**

This file answers "what was happening when the last session ended" — the things that are
*not* recoverable from code or git. It is intentionally short and intentionally volatile:
delete anything that has become false rather than keeping a history. History belongs in
`decisions.md` and `git log`.

Do not restate architecture here. Point at `docs/architecture.md`.

---

## Now

Phase 0 complete. Phase 1 is done except the schedule: **51 boards + Naukri alert email →
score → Telegram digest**, all against real data. 136 tests green, `tsc --noEmit` clean,
working tree clean, all pushed.

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

9 jobs in the DB, 6 MATCHED / 3 REJECTED, 3 of them from Naukri alert email. All 9 carry a
rubric **v3** score (`min 30, median 82, max 100`); ignore v1 and v2 rows, see below.

**Throughput is now the interesting constraint:** ~67s per scored job, 9 jobs in 10m02s, since
the pacer waits for token headroom instead of being refused (017). 30 jobs ≈ 35 min. The
digest therefore arrives when scoring finishes, not at a fixed 06:05.

**LinkedIn: alerts now exist, but no digest has arrived yet.** Utkarsh created job alerts on
2026-08-12 and the "your job alert has been created" confirmation reached the mailbox — which
proves both the alert and the forwarding filter work. A confirmation carries no job listings,
so there is still nothing to write a parser against, and writing one blind means guessing at
bulk-mail HTML. LinkedIn's first real digest arrives on its own daily schedule; watch
`alert_unparsed` in `runs.stats.ingest`, then use the `messages.ts` CLI to get the payload.

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
- **The free tier is 8,000 tokens/min and Groq charges prompt + `max_tokens`** at submission.
  That is two scoring calls a minute, ~30s per job. Hence `MAX_SCORES_PER_RUN = 60`, and hence
  the 429 wait is parsed out of the error body (013). Do not raise `max_tokens` for "headroom"
  — it is charged whether it is used or not.
- **Pacing is a token budget, not a timer** (017). `src/llm/rate-limit.ts` holds a per-model
  trailing-60s budget and waits for real headroom. The flat 700ms gap it replaced knew nothing
  about token cost and lost 2 of 9 jobs on 2026-08-11, one of them by *19 tokens*. The
  reservation is taken **before** the call because Groq charges at submission; moving it after
  the response reintroduces the bug.
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

**Nothing outstanding.** Every credential is in place, and on 2026-08-12 Utkarsh reported
doing all three of his remaining setup steps: LinkedIn job alerts created (confirmed — the
confirmation email arrived), OAuth consent screen published, and the Gmail display name set.

One thing to verify rather than assume: whether publishing the consent screen actually took.
`gmail.readonly` is a *restricted* scope, so Google may have held the app unverified. If a run
ever fails with `invalid_grant`, the 7-day Testing expiry is still in force and the fix is
either re-running `node src/gmail/auth.ts` weekly or a Workspace account on an own domain
(already on the later-phases list for deliverability anyway).

*(Target geography is settled — decision 009.)*

## Next action

**A launchd plist for the 06:00 run.** Everything works when run by hand; nothing runs on its
own. That is the last thing between Phase 1 and "a digest arrives each morning". Two plists
eventually (daily pipeline, and the 4-hourly tracker in Phase 3), but only the daily one is
needed now: `ingest → score → digest`.

Utkarsh said on 2026-08-12 he had done his three setup steps and told this session to carry on,
which covers the schedule — but **confirm before `launchctl bootstrap`** all the same, and
document the `bootout` command next to it. A background agent on someone's laptop should never
be a surprise.

Things a plist here gets wrong if written from memory: `launchd` runs with a near-empty
environment, so it needs the absolute `node` path and an explicit `WorkingDirectory`, and
`--env-file-if-exists=.env` only resolves relative to that directory. Send stdout/stderr to a
log file under the project, and prefer `StartCalendarInterval` over `StartInterval` so a closed
laptop catches up rather than drifting.

Then, in order of value:

- **The LinkedIn parser** — only once a real LinkedIn *digest* exists, not just the
  confirmation email. Watch `alert_unparsed` in `runs.stats.ingest`; when non-zero,
  `node src/gmail/messages.ts --query="from:linkedin.com" --links --full` gives the payload.
  Add one entry to `PARSERS` in `src/ingest/gmail-alerts.ts` — nothing else changes.
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
