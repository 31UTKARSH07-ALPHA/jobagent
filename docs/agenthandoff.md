# Agent handoff

Session-boundary state. **Read this first, update it last.**

This file answers "what was happening when the last session ended" — the things that are
*not* recoverable from code or git. It is intentionally short and intentionally volatile:
delete anything that has become false rather than keeping a history. History belongs in
`decisions.md` and `git log`.

Do not restate architecture here. Point at `docs/architecture.md`.

---

## Now

**Phase 2 is built and has run for real.** 2026-08-25: 67 matched jobs have a verified domain
and a contact, **8 real drafts are sitting in his Gmail**, nothing has been sent and nothing
can be — `drafts.send` does not exist outside Phase 3. 264 tests green, `tsc --noEmit` clean,
tree clean, all pushed. Full pipeline runs end to end in **3m24s**. Decisions 030–032.

| | |
|---|---|
| Companies with a verified domain | 64 of 83 (was 5) |
| Contacts | 27 high · 1 medium · 34 guessed |
| Jobs ready to draft | 67 |
| Jobs with no verified domain | 11, retrying every 3 days |

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
| the contacts stage hid 52 matches from the digest | 0 days | 031 — caught before a run |

**Three of those were caused by the fix before them,** and the last one nearly joined the
list: moving matched jobs to `DRAFTED` quietly emptied the digest, which selected
`state = 'MATCHED'`. It was caught by asking "what reads this state?" rather than by anything
failing. Before adding a limit or a state, work out what it makes the *new* first thing to
fail.

**As of 2026-08-24 the alerting loop is closed** — `[health] reported 2 new problem(s)` was
the first time the pipeline announced its own breakage on the day it happened (026). Trust the
alert, not the exit code.

### What Phase 2 turned out to be about

Not the cascade. **Domains.** 73 of the 78 matched jobs sat on `.unknown.invalid` markers
because they came from LinkedIn and Naukri alert mail, whose URLs name no company domain — and
every rung of the contact cascade keys off a domain. `src/contacts/domain.ts` is the piece
`phases.md` did not plan for and could not have worked without.

The rule that survived contact with reality is in 030: **guessing is fine, believing a guess is
not.** Every candidate — heuristic or model-proposed — must publish MX records *and* have the
company's whole name on its live home page. That caught two parked domains and three
English-word false positives (`chai.com` for Chai Point) out of 69 companies.

### The state of the last runs

- **contacts, 08-25:** 5m45s, 0 errors, 78 companies, 67 jobs advanced.
- **draft, 08-25:** 128s, 8 drafts written into Gmail, 0 errors, 0 sent.
- **full dry run, 08-25:** 3m24s, one draft rejected for "the company is never named" —
  the checker was matching `azuga,` with the comma. Fixed and verified.

## In flight

Nothing. Clean tree, no partial work.

## Read decisions 012–032 before touching the scorer, the digest, the parsers, the contacts stage or the schedule

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
- **Two Groq calls deliberately do not use structured output** — the domain lookup (030) and
  the drafter (032). Strict `json_schema` mode returned `400` on 10 of 12 domain lookups and on
  2 of the first 3 drafts, in both cases for the *correct* answer: an empty string for "I don't
  know", and a long multi-line email body. A schema is right for the scorer's four integers and
  wrong for a text-shaped answer. Do not "fix" these back to `complete()`.
- **`reasoning_effort: 'low'` on drafting is not a micro-optimisation** (032). Left at the
  default, `gpt-oss-120b` spent 774 of its 900 tokens thinking and returned a truncated email;
  the thinking is billed *inside* `max_tokens`, not beside it. Low takes it to 15 tokens and
  1.8s per draft. And `finish_reason: 'length'` is now an error rather than a half-written
  result, which matters to the scorer too.
- **Never pass `job_scores.reasoning` into a draft prompt** (032). It is written in the rubric's
  voice — "a final-year student can take this role" — and the model repeated that to a
  recruiter as fact. His resume says 2024–2027. The hook is what the draft needs; the reasoning
  is for him.
- **A high-confidence rung can auto-send, so what it accepts matters more than what it finds**
  (031). Two addresses got through that should not have: customer-service desks
  (`support@`, `customercare@`), and *another company's* mailbox — an aggregator's page listing
  `jobs.accommodations@sandisk.com`. A page can name any address it likes; that does not make
  it the page owner's.
- **The plist is generated, never committed** (018), because every path in it is specific to
  this laptop. `--print` shows exactly what `--install` writes. Do not hand-edit the installed
  file — `--install` overwrites it. And `RunAtLoad` stays `false`: loading the agent must not
  fire a pipeline run and a real digest.

## Coverage problem worth understanding before building more

102 of 153 hand-picked candidate companies have **no board on Greenhouse/Lever/Ashby/
Workable** — including nearly every large Indian company (Zomato, Swiggy, Flipkart, Zerodha,
Razorpay, Freshworks, Zoho). They run their own portals, Workday or Darwinbox. So the 51
verified boards skew global/remote, and Indian coverage comes from `src/ingest/gmail-alerts.ts`.
That makes Gmail OAuth **the** blocker for a useful digest. Full reasoning in 010.

**The downstream half of this is now solved.** Alert-sourced companies arrive as a bare name
with no domain, which used to mean no contact was possible for 94% of matches; `domain.ts`
resolves 86% of them and proves each one (030). What remains unsolved is *ingest* coverage —
more Indian postings, not more contacts for the ones already found.

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

**0a. `data/profile.json` was hand-corrected on 2026-08-27 and those edits are NOT in git**
(the file is gitignored, and `node src/match/profile.ts` regenerates it from the resume PDF and
will silently overwrite them). Decision 034 records exactly what changed. Two claims were
wrong against Utkarsh's own repositories: "Reduced DB writes by 5×" where his `CHANGES.md`
measured **1.08**, and two projects named "Distributed" where one is a single-host Docker
cluster and the other has no network at all. **The durable fix is the resume PDF, which is
his to edit** — until then the PDF and the emails disagree, and re-extracting the profile
undoes the correction.

**0. He read the eight drafts on 2026-08-27 and they are approved in substance** — "now its
looking good emails to reach out". One thing came back: they had no greeting. Seven of eight
opened mid-sentence, one said "Hi Stripe Team," — fixed in 033, along with his instruction
never to greet by a name the posting did not give. All eight were rewritten in place with
`--redraft`. **What has still never been tested is a reply**, because nothing has been sent.

**1. Re-read the eight drafts if anything about them changes.** They are in his Gmail Drafts folder right now, and this is the
only thing that decides whether Phase 2 worked. `phases.md` says it plainly: *done when you
read ~5 drafts each morning and would genuinely send 3 of them.* Nothing in the code can
answer that.

What to ask him, per draft: would you send this? If not, is it the **hook** (wrong thing about
him), the **address** (wrong desk), or the **tone**? Each answer lands somewhere different —
the hook is `job_scores.hook` and belongs to the scorer, the address is the cascade's ranking
in `src/contacts/cascade.ts`, the tone is `SYSTEM` in `src/draft/compose.ts`. Do not guess
which; the whole point of writing eight was to find out.

One thing already visible without asking: **six of the eight subject lines lead with the same
typeahead project**, because most jobs got the same hook from the scorer. No single recruiter
sees the repetition, so it is not a bug — but if he wants variety, the fix is in the scorer's
hook selection, not in the drafter.

**2. Check the 08-26 06:00 run.** First unattended run with contacts and draft in it.

```
node src/schedule/launchd.ts --status
tail -80 logs/daily.log
```

Expect ~4 minutes, `[contacts]` and `[draft]` lines, and 8 more drafts. Two specific things
that would be new-bug shaped: a `[draft]` fault naming the same company every morning, or
`[contacts] domain_unresolved` climbing past the 11 known misses.

**3. The Gmail token expiry is unproven until 1 September** — see *Blocked on Utkarsh*.

**4. Two open questions that still need Utkarsh, not code.**

- **The digest backlog, now sharper.** 67 jobs are ready to draft against
  `MAX_DRAFTS_PER_RUN = 8`, and the digest shows 10 matches and 5 drafts. That is over a week
  of queue, and 57 of 90 scores tie at exactly 84, so the tiebreak decides what he reads. It is
  newest-first (027), right for postings that expire, but it starves the tail. The honest fix
  is a **bigger digest** or a queue that **expires** unsent matches after about a week. Not a
  third ordering. Ask him which.
- **Suppression.** Now real rather than hypothetical: two roles at one company produce two
  drafts to the *same* address (there is a test asserting exactly that). Convin, Uplers and
  Spyne each have more than one open role. Does the second one queue for approval, or wait
  until the first is answered? Phase 3 needs this decided before it can send anything.

**4a. The re-score that is now owed.** The profile changed, so the 95 stored hooks were written
from a version of his resume that no longer stands — 63 of them say "distributed", and the 8
drafts in Gmail still open on it. Nothing is false enough to be urgent (the Redis Cluster is
real; only the 5× was wrong, and that hook was regenerated), but the emails will not reflect
the corrected wording until `PROMPT_VERSION` is bumped and `node src/match/score.ts --rescore`
runs (~45–100 min unattended), followed by `node src/draft/index.ts --redraft`. **Wait for the
resume PDF to be updated first**, then re-extract the profile, then do it once — and re-check
`MATCH_THRESHOLD` against the new distribution (024), because job 78 already moved to exactly
70 under the corrected profile.

**5. Then the work, and the fork from last session is still open.**

- **Phase 3 — sending.** Everything it needs now exists: `outreach` rows with real
  `gmail_draft_id`s, contacts with confidence, and a `mx_valid` gate. It starts with
  `src/send/gate.ts` and the ramp (3/day → 5 → 8, mandatory). **Do not start this until he has
  read the drafts** — Phase 3 automates sending whatever Phase 2 produces, and if the drafts
  are wrong it automates being wrong.
- **The company signal in the rubric (v5).** 57 of 90 jobs score exactly 84 because a title
  like "Software Engineering Intern" tells the model everything and nothing. The employer is
  the evidence being thrown away — a bare "Intern - Engineering" at CoinDCX is worth more than
  a bare "Intern" at a brewery. This is the only change that fixes both the tie *and* the false
  negatives (024). Fold in the returnship fix at the same time: `level_fit` rates a "ReStart
  Consultant" career-break programme as a student internship. One rubric version, one
  ~100-minute re-score, buys both. **It is also worth more now than it was**, because the score
  no longer just orders a digest — it decides which 8 jobs get an email written.

**6. Nothing is knowingly unfixed.** Every network call honours a deadline (029), and the
contacts and draft stages were built with `ctx.signal` plumbed from the start plus their own
per-company budget. If a run overruns, the question is still which I/O path was added since.

Deliberately deferred:
- `src/match/embed.ts` — bge-small prefilter. At ~5 new jobs a day, scoring everything is
  cheaper than installing ~500MB of ONNX runtime. The TPM ceiling in 013 is what will make it
  earn its keep, and drafting now shares that same budget.
- **GitHub commit-log mining.** The cascade asks GitHub only for an org's public email, which
  found exactly 1 contact in 78 companies. Mining commits costs three more requests against an
  unauthenticated 60/hour limit and yields an engineer's address rather than anyone who hires.
  Revisit only if the team-page rung stops working.
- More ATS coverage — add names to `src/ingest/candidates.ts`, run
  `node src/ingest/refresh-companies.ts`. It only *adds* verified boards; a company is
  removed only when a probe confirms it is gone, never when a probe errors.

Deps installed so far: `zod`, `unpdf`, `typescript`, `@types/node`, `@googleapis/gmail`. No LLM
SDK — Groq speaks the OpenAI chat shape, so `src/llm/groq.ts` is plain `fetch`. The rest
(`@huggingface/transformers`, `grammy`) gets installed when the stage that needs it is written,
not before.

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
- **One hand-edit on 2026-08-25**, the second ever: job 30 was reset `DRAFTED → MATCHED` and a
  bad contact row deleted, to re-run it after the SanDisk fix in 031. Safe only because no
  `outreach` row existed. The state machine has no such edge on purpose and no stage may do it.

## Open questions not yet settled

- Daily send cap: architecture says ramp to 8/day; original ask was 10–20. Not resolved.
- Follow-ups: one at day 4, or none in v1?
- Suppression: second role at an already-emailed company — approval queue, or skip? **No longer
  hypothetical:** the draft stage writes one email per job, so two roles at one company are two
  drafts to the same address today. Phase 3 must resolve this before it sends.
- Whether a `careers@` guess is worth sending at all. 34 of 62 contacts are guesses; they can
  never auto-send, so every one of them is a tap he has to make. If he ignores them in
  practice, the cascade should stop producing them rather than fill the queue.

---

### How to update this file

At the end of a working session, rewrite `Now`, `In flight`, and `Next action`. Move
anything *decided* into `decisions.md` and delete it from here. If this file grows past
one screen, it has become a log — trim it.
