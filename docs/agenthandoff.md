# Agent handoff

Session-boundary state. **Read this first, update it last.**

This file answers "what was happening when the last session ended" — the things that are
*not* recoverable from code or git. It is intentionally short and intentionally volatile:
delete anything that has become false rather than keeping a history. History belongs in
`decisions.md` and `git log`.

Do not restate architecture here. Point at `docs/architecture.md`.

---

## Now

**Phase 1 is closed.** The 2026-08-14 06:11 run was scheduled, unattended, exit 0, and reported
3 matches to Telegram — the criterion, met. 161 tests green, `tsc --noEmit` clean, tree clean,
all pushed. The repo lives at **`~/jobagent`** and must never move back under Desktop,
Documents or Downloads (decision 018a).

**Then three days of scheduled runs found nothing, and it took reading the logs to notice.**
Two separate faults, both now fixed, both worth understanding before trusting a green run:

1. **No network at 06:00** (019). launchd runs a missed calendar job when the laptop *wakes*,
   Wi-Fi associates a minute later, and both runs started ~06:12 against a dead resolver: 51
   boards failed, `getaddrinfo ENOTFOUND oauth2.googleapis.com`, **55 minutes** to reach zero
   jobs. The same ingest by hand takes 38 seconds. `scripts/run-daily.sh` now waits for the
   network and skips with exit 75 rather than writing a run of failures.
2. **The digest's silence hid it** (014). Zero jobs and an hour of failing DNS look identical
   from the phone. That is still the right default — but it means *the logs are the only place
   a dead morning shows up*. Check `--status` and `logs/daily.log`, not your Telegram.

**LinkedIn is live** (020). 26 digests had piled up as `alert_unparsed`, exactly as intended,
and there is now a parser written against them. Alert postings went 6 → 67 in one run.

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
| **What launchd runs, run by hand** | `./scripts/run-daily.sh [--dry-run]` |
| **Is the schedule alive?** | `node src/schedule/launchd.ts --status` |
| **Reload it after an edit / remove it** | `node src/schedule/launchd.ts --install` / `--uninstall` |
| Any model call | `complete()` / `chat()` in `src/llm/groq.ts` |

**Gmail is live.** Authorised as `3107utkarshpathak@gmail.com` (`token.json`, mode 600),
scopes readonly + compose + send. Telegram bot `@utkarsh_jobagent_bot`, token and chat id in
`.env`. Utkarsh forwards LinkedIn and Naukri mail into that mailbox with Gmail *filters* —
note that Gmail's "Disable forwarding" radio only governs blanket forwarding, so a filter
forwards regardless of what that radio says.

**39 jobs in the DB: 30 DISCOVERED, 6 MATCHED, 3 REJECTED**, across 33 companies. The 30 are
unscored and waiting for the next 06:00 run — at ~67s each that is **~34 minutes** of scoring,
inside `MAX_SCORES_PER_RUN` (60) but the longest run yet. The 9 older jobs carry a rubric **v3**
score (`min 30, median 82, max 100`); ignore v1 and v2 rows, see below.

**Throughput is the constraint:** ~67s per scored job, since the pacer waits for token headroom
instead of being refused (017). The digest arrives when scoring finishes, not at a fixed 06:05.

**Both alert parsers are live and were written against real mail** — Naukri 2026-08-11,
LinkedIn 2026-08-16 (016, 020). Between them they are now the main source of jobs: 67 alert
postings per run against 9 from all 51 ATS boards combined, which is decision 010's coverage
argument showing up in the numbers.

Not built yet: contacts, drafting, sending. `src/main.ts` still logs those stages as no-ops.

## In flight

Nothing. Clean tree, no partial work.

## Read decisions 012–018 before touching the scorer, the digest, the parsers or the schedule

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
- **The plist is generated, never committed** (018), because every path in it is specific to
  this laptop. `--print` shows exactly what `--install` writes. Do not hand-edit the installed
  file — `--install` overwrites it. And `RunAtLoad` stays `false`: loading the agent must not
  fire a pipeline run and a real digest.

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

**Check the 2026-08-17 06:00 run — it is the first with real volume**, and the first that
exercises the network gate on a cold morning.

```
node src/schedule/launchd.ts --status     # last exit code: 0 ran, 75 = skipped, no network
tail -60 logs/daily.log                   # "waiting for the network" then ~34 min of scoring
```

Expect roughly 30 jobs scored and a digest with real matches in it. What to look at:

- **`score.scored` in `runs.stats`** should be ~30. Much lower means the run hit
  `MAX_SCORES_PER_RUN` or the pacer stalled.
- **Exit 75** means the network never came up in 15 minutes — the laptop was probably shut.
  Not a bug; the next morning retries. Repeated 75s are a scheduling question, not a
  networking one.
- **The old traps**, in order of likelihood: the repo moved back under
  Desktop/Documents/Downloads (018a); macOS disabled the agent under System Settings →
  General → Login Items & Extensions, where `--status` still says `loaded`; or Gmail's token
  expired with `invalid_grant` — see *Blocked on Utkarsh* above.

Then, in order of value:

- **The calibration gate, finally unblocked** (008). It needed volume and now there is some:
  after the 08-17 run, `node src/match/score.ts --distribution`. **Split the numbers by
  source** — ATS postings carry a full JD, alert postings carry none and are clamped to 82
  (016), so one threshold across both compares unlike things. `70` / `85` are still guesses.
- **Watch what LinkedIn's volume does to the run time.** 67 alert postings a run is a lot more
  than this was designed around; if most survive the title filter, `MAX_SCORES_PER_RUN` (60) at
  67s each is over an hour. That is the point at which `src/match/embed.ts` — the deferred
  bge-small prefilter — starts earning its keep, because it is the only lever that cuts the
  *number* of scoring calls.
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

- Daily send cap: architecture says ramp to 8/day; original ask was 10–20. Not resolved.
- Follow-ups: one at day 4, or none in v1?
- Suppression: second role at an already-emailed company — approval queue, or skip?

---

### How to update this file

At the end of a working session, rewrite `Now`, `In flight`, and `Next action`. Move
anything *decided* into `decisions.md` and delete it from here. If this file grows past
one screen, it has become a log — trim it.
