# Agent handoff

Session-boundary state. **Read this first, update it last.**

This file answers "what was happening when the last session ended" — the things that are
*not* recoverable from code or git. It is intentionally short and intentionally volatile:
delete anything that has become false rather than keeping a history. History belongs in
`decisions.md` and `git log`.

Do not restate architecture here. Point at `docs/architecture.md`.

---

## Now

**Phase 1 is closed** (2026-08-14 06:11: scheduled, unattended, 3 matches to Telegram).
171 tests green, `tsc --noEmit` clean. The repo lives at **`~/jobagent`** and must never move
back under Desktop, Documents or Downloads (018a).

**Read this before trusting a green run.** Every failure since Phase 1 closed has been silent
— exit 0, nothing delivered — and each fix exposed the next one:

| When | Looked like | Actually was |
|---|---|---|
| 08-14, 08-15 | exit 0, no jobs | no network at 06:00; 55 min of DNS timeouts (019) |
| 08-16 | digest at 13:24 | no stage deadline; 7-hour run (022) |
| 08-17 → 08-20 | exit 0, no digest | one `fetch failed`, no retry (022) |
| 08-19 → **now** | `source_failed: 1` | **Gmail token expired — still unfixed, needs Utkarsh** |
| all of them | 27 of 29 "matched" | the score was the constant 82 (023) |
| 08-21 → 08-23 | exit 0, no digest | the gate trusted one host; the budget starved the best source (025) |

**The lesson that keeps repeating** (025): each fix bounded whatever had just failed without
asking what would fail *first* once it was bounded. A budget without an ordering starves the
tail. A gate on one host says nothing about the next. When adding a limit, work out what it
makes the new bottleneck.

**And the reason none of it was noticed for a week:** the digest is silent when nothing
matched (014), so a dead morning and a quiet one look identical from the phone. That default
is still right, but it means **the logs are the only place a failure shows up** — `--status`
and `logs/daily.log`. Making a broken *credential* shout is the top item under *Next action*.

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

**39 jobs in the DB across 33 companies**, all scored. Rubric **v4** as of 2026-08-20 — ignore
v1, v2 and v3 rows for calibration (v1 ran at temperature 1.0, v2 predates the title-only
handling, v3 *is* the flat-82 bug that 023 fixes).

**Throughput is the constraint:** ~67s per scored job, since the pacer waits for token headroom
instead of being refused (017). The digest arrives when scoring finishes, not at a fixed 06:05.

**Both alert parsers are live and were written against real mail** — Naukri 2026-08-11,
LinkedIn 2026-08-16 (016, 020). Between them they are now the main source of jobs: 67 alert
postings per run against 9 from all 51 ATS boards combined, which is decision 010's coverage
argument showing up in the numbers.

Not built yet: contacts, drafting, sending. `src/main.ts` still logs those stages as no-ops.

## In flight

Nothing. Clean tree, no partial work.

## Read decisions 012–025 before touching the scorer, the digest, the parsers or the schedule

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
- **A missing description discounts the total by 15%, capped at 84 — it does not touch the
  factor ratings** (023, superseding 016's clamp). Both directions here are load-bearing and
  were each learned the hard way. Clamping the *factors* to 6 made 31 of 32 alert postings
  score exactly 82, so the score ranked nothing and 27 of 29 postings "matched". Removing the
  discount entirely takes you back to 016: three Naukri titles tying Stripe's fully-described
  internship at 100. The 84 ceiling is what keeps a posting nobody has read out of Phase 3's
  auto-send band (>85). Store what the model said; discount the result.
- **Naukri's parser reads the URL slug, not the visible text** (016) — the rendered email
  truncates the company to "Discover Dollar Tec…". Re-verify with the `messages.ts` CLI above
  if it ever returns nothing; the failure mode is silence, not an error.
- **The digest takes each job's newest score, never a pinned `PROMPT_VERSION`.** Pinning
  looked tidier and dropped already-matched-but-unreported jobs from the digest forever on
  the first rubric bump.
- **Sources are polled best-first and each gets 3 minutes** (025). Alert email leads because
  it is 67 of 76 postings and takes 23 seconds; it was last, and got starved on three
  consecutive mornings by five Lever boards that were not answering. Do not reorder for
  tidiness, and do not remove `SOURCE_BUDGET_MS` — a stage budget alone says when to stop, not
  who got the time.
- **The network gate checks Telegram, Groq *and* Google** (025), because on 2026-08-23 DNS
  resolved `oauth2.googleapis.com` in 10 seconds while `api.lever.co` hung for 1048. One host
  proves nothing about the next. Board hosts are excluded on purpose: a dead ATS is normal.
  `curl --max-time` is used rather than node because node's `AbortSignal.timeout` does **not**
  interrupt a stuck `getaddrinfo` — that is the whole reason a 15s request timeout became a
  17-minute source.
- **`STAGE_BUDGET_MS['digest']` must exceed the send's worst case** (025). Four attempts × a
  20s timeout plus the 2+8+32s ladder is ~122s per message part, and a ten-match digest is two
  or three parts. At 5 minutes the budget was killing the retries it existed to permit.
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

**The Gmail token is expired and job ingest is off.** Since ~2026-08-19:

```
[ingest] source gmail-alert failed: invalid_grant
```

This is the 7-day Testing-mode expiry, exactly as predicted on 08-12 — so **publishing the
consent screen did not take**. `gmail.readonly` is a *restricted* scope, so Google may simply
be holding the app unverified. It matters more than it used to: alert email is **67 of 76
postings**, against 9 from all 51 ATS boards combined.

Fix now: `node src/gmail/auth.ts` (opens a browser, ~20 seconds). Fix properly: confirm the
consent screen is really published, or move to a Workspace account on an own domain — already
on the later-phases list for deliverability anyway.

Worth building either way: nothing told anybody. A dead credential shows up as
`source_failed: 1` in `runs.stats` and a log line, and the digest is silent by design (014).
That is the recurring shape of every failure in the table above.

*(Target geography is settled — decision 009.)*

## Next action

**1. Re-authorise Gmail — still not done, and it is now the only thing stopping new jobs.**

```
node src/gmail/auth.ts      # opens a browser, ~20 seconds
```

Failing since ~08-19 with `invalid_grant`, so **no new postings have entered the DB in four
days**. Alert email is 67 of 76 postings. Also confirm the consent screen is genuinely
published in Google Cloud Console: the 7-day Testing expiry firing at all says it is not, and
`gmail.readonly` being a restricted scope means Google may be holding the app unverified.

**2. Make a broken credential shout.** This is the same failure five times over: the tool
breaks, `runs.errors` and `runs.stats.*_failed` record it perfectly, and nobody looks. 014
forbids a *heartbeat* — a usually-empty daily message you stop reading — and that still holds.
This is the opposite: a message sent **only** when a stage or source fails, and only when the
previous run did not already report the same fault, so a persistent problem costs one message
rather than one a day. Everything needed is already in `runs`.

**3. Phase 2 — contacts and drafts.** Unblocked, unstarted, and the largest remaining piece.
Its first problem is already known: `resolveCompany` returns `.unknown.invalid` for nearly
every alert-sourced company, because they are small firms absent from `candidates.ts`. With 33
companies now, most from email, the cascade has to *find* a domain from a name rather than
assume one exists.

**4. The company signal in the rubric** (024's conclusion). A bare "Intern - Engineering" at
CoinDCX is worth more than a bare "Intern" at a brewery, and `data/companies.json` already
knows the difference. It is the one change that would fix both remaining scoring weaknesses —
the 22-way tie at 84 and the false negatives on bare-but-real titles — because it adds
information rather than re-weighting what is already there. Fold in the returnship fix
(`level_fit` rated a "ReStart Consultant" career-break programme as a student internship) so
one rubric version and one 40-minute re-score buys both.

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
