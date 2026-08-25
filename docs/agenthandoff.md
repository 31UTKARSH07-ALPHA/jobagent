# Agent handoff

Session-boundary state. **Read this first, update it last.**

This file answers "what was happening when the last session ended" — the things that are
*not* recoverable from code or git. It is intentionally short and intentionally volatile:
delete anything that has become false rather than keeping a history. History belongs in
`decisions.md` and `git log`.

Do not restate architecture here. Point at `docs/architecture.md`.

---

## Now

**Phase 1 works and is scheduled.** 90 jobs scored under rubric v4, 74 matched, 16 rejected,
78 companies. 186 tests green, `tsc --noEmit` clean, tree clean, all pushed. Repo lives at
`~/jobagent` and must never move under Desktop/Documents/Downloads (018a).

**Read `SUMMARY.md` if you want the project in plain language.** It is written for Utkarsh, not
for you, and it is the fastest way to get oriented.

### The thing to understand before changing anything

Every failure in this project's first three weeks was **silent** — a green exit code, an empty
digest, and the cause sitting in `runs.errors` where nobody looked:

| Broke | Noticed | Fixed by |
|---|---|---|
| no network at 06:00 | 2 days | 019 network gate |
| a stage with no deadline (7-hour run) | 4 days | 022 stage budgets |
| digest could not send | 4 days | 022 send retries |
| Gmail token expired | 4 days | re-auth; 026 now alerts |
| score was secretly the constant 82 | 2 weeks | 023 rubric v4 |
| gate trusted one host; budget starved the best source | 3 days | 025 |
| the Gmail path never received the deadline | 1 day | 028 |
| the Groq path never received it either (2.9h on 3 jobs) | 1 day | 029 |

**Three of those were caused by the fix before them.** 025 and 028 both record the same lesson
at different levels: bounding a thing only bounds the paths you actually bounded, and a limit
without an ordering just moves the bottleneck. Before adding a limit, work out what it makes
the *new* first thing to fail.

**As of 2026-08-24 that loop is finally closed** — `[health] reported 2 new problem(s)` in that
morning's log is the first time the pipeline announced its own breakage on the day it happened
(026). Trust the alert, not the exit code.

### The state of the last run

08-25 06:10 ran for **four hours** and both fixes in it were half-right, which is the useful
part:

- **028 worked.** `gmail-alert: 59 kept in 933s` — the Gmail source honoured its deadline and
  logged a line, where the morning before it hung and logged nothing at all.
- **But scoring took 2.9 hours on three jobs**, because Groq was the last path with no
  deadline. Fixed the same day (029). **Unverified — the 08-26 06:00 run is its first test.**

Every network call in the project now honours a deadline. That specific class of bug should be
closed; if a run overruns again, the first question is which new I/O path was added.

## In flight

Nothing. Clean tree, no partial work.

## Read decisions 012–029 before touching the scorer, the digest, the parsers or the schedule

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

**Nothing blocking.** Gmail was re-authorised on 2026-08-25 **after** the OAuth consent screen
was set to *In production*, and the old Testing-era grant was revoked at
`myaccount.google.com/permissions` first — publishing does not retroactively fix a token
already issued, which is why the revoke mattered.

**The one thing to watch:** that fix is only provable by the calendar. The old 7-day clock
would have expired the token around **2026-08-30**. If 1 September passes with no
`invalid_grant` in `logs/daily.log`, it is genuinely fixed. If it dies again, publishing did
not take for this grant and the answer is a Google Workspace account on an own domain, where
the app is *internal* and none of this applies — already on the later-phases list for email
deliverability anyway. See 015a for why *verification* is a different thing and not worth
pursuing.

*(Target geography is settled — decision 009.)*

## Next action

**1. Check the 08-26 06:00 run.** First test of 029, and the first run where every network
path has a deadline.

```
node src/schedule/launchd.ts --status     # 0 ran · 75 skipped, no network · anything else, read on
tail -60 logs/daily.log
```

Two things to look for: ingest logs a line per source (`gmail-alert: N kept` missing entirely
is 028 regressing), and the whole run finishes in minutes rather than hours (029). A Telegram
message about failures means 026 is working — that is the system behaving, not a new problem.

**2. The Gmail token expiry is unproven until 1 September** — see *Blocked on Utkarsh*.

**3. Two open questions that need Utkarsh, not code.** Both are recorded in full in 027 and
024; neither should be guessed at:

- **The digest backlog.** 46 matches are queued against `MAX_ITEMS_PER_DIGEST = 10`, so about
  five days of it, and 57 of 90 scores tie at exactly 84 — the tiebreak decides what he
  actually reads. It is newest-first now (027), which is the right direction for postings that
  expire, but it starves the tail: Sony Research India's AI Research Intern may never be sent.
  The honest fix is a **bigger digest** or a queue that **expires** unsent matches after about
  a week. Not a third ordering. Ask him which.
- **The Gmail consent screen is still in Testing**, so the token expires every 7 days and takes
  the main job source with it. Last re-authorised 2026-08-23, so **expect it to die around
  08-30**. 015a explains why *publishing* fixes this and *verification* is not worth pursuing.

**4. Then the real work, and it is a genuine fork.**

- **The company signal in the rubric (v5).** 57 of 90 jobs score exactly 84 because a title
  like "Software Engineering Intern" tells the model everything and nothing. The employer is
  the evidence being thrown away — a bare "Intern - Engineering" at CoinDCX is worth more than
  a bare "Intern" at a brewery, and `data/companies.json` already knows which is which. This is
  the only change that fixes both the tie *and* the false negatives (024), because it adds
  information rather than re-weighting what is there. Fold in the returnship fix at the same
  time: `level_fit` currently rates a "ReStart Consultant" career-break programme as a student
  internship. One rubric version, one ~100-minute re-score, buys both.
- **Phase 2 — contacts and drafts.** The larger piece and the actual product. Its first problem
  is already known: `resolveCompany` returns `.unknown.invalid` for most alert-sourced
  companies, because they are small firms absent from `candidates.ts`. With 78 companies, most
  from email, the cascade has to *find* a domain from a name rather than assume one exists.

Sharpening the rubric makes what exists better; Phase 2 adds what the project is actually for.
**Utkarsh has not chosen between them** — the last session offered both and he did not answer.

**5. Nothing is knowingly unfixed.** As of 029 every network call honours a deadline. The four
entries 022 → 025 → 028 → 029 are all the same bug found one path at a time; if a run overruns
again, the question to ask is which I/O path was added since.

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
