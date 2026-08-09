# Decisions

Append-only. Newest at the bottom. Never edit an entry — supersede it with a new one.

This is the *why* log. Code shows what, `git log` shows when, this shows why. It is the
only one of the three that cannot be reconstructed later, which is what makes it the most
valuable file in `docs/`.

Format: `## NNN — Title` / **Decision** / **Why** / **Rejected** / **Revisit when**.

---

## 001 — State lives in SQLite, not in the pipeline process

**Decision.** The daily run is a set of stages that pick up rows in a given state, do
work, and advance the state. No data is carried in memory between stages.

**Why.** Makes crashes free. A failure at stage 5 leaves stages 1–4 durable; the next run
resumes. Removes the need for a retry queue or dead-letter table entirely — retry is just
"the row is still in that state tomorrow".

**Rejected.** A single top-to-bottom script. Simpler to write, but every transient
failure loses a full day of work.

**Revisit when.** Never, realistically. This is load-bearing for everything else.

---

## 002 — Skip the Batch API

**Decision.** Score synchronously. Keep the scorer behind an interface so batching can be
added later.

**Why.** At ~30 scored jobs/day the 50% batch discount saves about $1.50/month, in
exchange for making the pipeline asynchronous — submit, poll, collect across separate
cron runs. Bad trade. (An earlier version of the plan recommended batching; the numbers
did not support it.)

**Revisit when.** Volume grows ~10×, or scoring moves to Opus.

---

## 003 — Model routing: Haiku scores, Opus drafts

**Decision.** `claude-haiku-4-5` for the ~30 daily scorings, `claude-opus-5` for the ~5
email drafts and the one-time resume parse.

**Why.** Scoring against a rubric is a task Haiku does well; Opus there roughly triples
total cost for no measurable gain. Drafting is the output a human recruiter actually
reads — that is where the capability is worth paying for. Lands around $7/month total.

**Revisit when.** Score quality looks poor after the Phase 1 calibration gate.

---

## 004 — No LinkedIn or Naukri scraping

**Decision.** Ingest both by parsing Utkarsh's own Gmail job-alert emails.

**Why.** Neither has a jobs API; scraping risks account bans on the two platforms he most
needs access to. Alert emails carry the same postings, are legal, free, and require no
anti-bot maintenance. They also inherit whatever geography filters he set on-platform,
which conveniently removes a config knob.

**Rejected.** Paid scraping proxies (Apify, Bright Data) — outside the free-tier budget.

---

## 005 — Contacts are cached per company, not per job

**Decision.** `contacts` rows are keyed to `company_id`. The discovery cascade runs once
per company.

**Why.** The cascade (team-page scrape → GitHub commit emails → pattern inference) is the
slowest and least reliable stage. Running it per job would repeat identical work for
every role at the same company. Per-company caching is what makes contact discovery
viable at all on a free-tier budget.

**Revisit when.** We start targeting specific hiring managers per team rather than one
recruiter per company.

---

## 006 — Hybrid send gate keyed on source confidence, not a verifier API

**Decision.** Auto-send only when the contact has `confidence='high'` (email came from
the job posting itself or a company team page) **and** `fit_score > 85`. Everything else
— including all pattern-guessed emails — goes to the approval queue.

**Why.** Paid verification is outside budget. Source provenance turns out to be a better
signal than a verifier API anyway: a scraped-from-team-page address is almost always
real, a pattern guess is ~50/50, and bounces are what actually destroy sender reputation.
An MX check on the domain is a free additional gate.

---

## 007 — Send via Gmail drafts, never `messages.send`

**Decision.** Always `drafts.create` → persist `gmail_draft_id` → `drafts.send(id)`.
Backed by `UNIQUE(job_id)` on `outreach`.

**Why.** A double-send is the only bug here with real-world consequences. Drafts make
ambiguous failures recoverable: on a timeout, query whether the draft still exists —
gone means it sent. It also gives one code path for auto-sent and approved mail, and a
real audit trail in the Gmail Sent folder.

---

## 008 — Thresholds are placeholders until calibrated

**Decision.** `70` (MATCHED) and `85` (auto-send) are guesses. Phase 1 includes a gate:
run scoring only for 3 days, inspect the real distribution, then set them.

**Why.** Score distributions depend entirely on the rubric and the resume. Picking
thresholds before seeing real numbers means either drowning in bad matches or auto-sending
nothing. `job_scores` is keyed on `prompt_version` specifically so re-scoring does not
destroy the comparison.

**Revisit when.** Phase 1 calibration completes — record the observed distribution and
the chosen values as a new decision.

---

## 009 — Target geography: India plus remote-global

**Decision.** Seed and filter for Indian companies and for remote-first companies that
hire globally. US/Europe-onsite-only companies are excluded. Enforced at ingest by
`matchesGeography` in `src/ingest/filter.ts`.

**Why.** Utkarsh is India-based. A US onsite internship scores well on skills and is then
a dead end on work authorisation, which is the worst possible failure mode: it burns a
scoring call, a contact lookup, a draft, and a send slot to produce nothing.

**Rejected.** Including US/Europe and letting the scorer sort it out. The scorer is a
per-job cost; a regex is free.

**Note.** The filter only *rejects* when a location clearly names somewhere else. Remote,
Indian, and unlabelled locations are all kept — the scorer is still the judge.

---

## 010 — The company seed list is generated and verified, never hand-written

**Decision.** `data/companies.json` is produced by `src/ingest/refresh-companies.ts`,
which guesses slugs from `src/ingest/candidates.ts` and keeps only boards that answer
with at least one live posting. It is the one thing under `data/` that is committed.

**Why.** ATS slugs look guessable and are wrong about half the time —
`boards-api.greenhouse.io/v1/boards/razorpay` is a 404 although Razorpay is real, and 102
of 153 hand-picked candidates turned out to have no board on the four supported ATSes at
all. A hand-written list would poll dead URLs indefinitely and nobody would notice.

**Consequence worth knowing.** Most large Indian consumer companies — Zomato, Swiggy,
Flipkart, Zerodha, Freshworks, Zoho — are not on Greenhouse/Lever/Ashby/Workable. They
run their own portals or Workday/Darwinbox. **Indian coverage therefore depends on the
Gmail alert source, not the ATS pollers.** That makes `src/ingest/gmail-alerts.ts` a
higher priority than it looks in the Phase 1 list.

**Rejected.** Scraping the YC directory for slugs (the original Phase 1 plan). Same
verification problem, more moving parts, and YC skews US-onsite — the wrong geography.

---

## 011 — Groq runs both LLM stages. Supersedes 003

**Decision.** Scoring *and* drafting run on Groq's free tier. No Anthropic API spend.
Both stages sit behind a provider interface (`src/llm/`), so swapping either one back
is a one-file change.

**Why.** The Anthropic API is prepaid with no free tier — the routing in decision 003
worked out to roughly $7/month (scoring ~$3.30, drafting ~$3.75, at 30 scored jobs and
5 drafts a day). The budget line for this project is free tiers only, and Groq's free
tier covers both stages at this volume.

**Known tradeoff, accepted.** Scoring is a rubric task and should be unaffected. Drafting
is the part that degrades: the email is the only thing a recruiter ever sees, and open
models write competent but more generic cold emails — which is the exact failure mode
that gets ignored. Utkarsh chose free over that difference with the tradeoff stated.

**Also lost:** prompt caching on the drafting stage (an Anthropic feature). At ~150 drafts
a month it was not saving much anyway.

**Revisit when.** Reply rate after the first few weeks of sending. If drafts are getting
ignored, moving *only* the drafting stage to `claude-opus-5` costs ~$3.75/month and is a
one-file change — that is the first thing to try, before rewriting prompts.

---

## 012 — The model rates factors; the score is arithmetic

**Decision.** The scorer does not choose a 0–100 fit score. It rates four narrow factors
0–10 — `level_fit`, `location_fit`, `stack_fit`, `domain_fit` — and `fitScore()` in
`src/match/score.ts` combines them with fixed weights. Two hard gates live in that
function, not in the prompt: a `level_fit` or `location_fit` of 0 or 1 caps the total at
30, below the MATCHED threshold. Scoring also runs at `temperature: 0`.

**Why.** Measured 2026-08-10, asking for one holistic score: the *same* Canonical posting
scored **55, 78, 90 and 92** on four runs of an identical prompt. `REJECTED` is terminal,
so that spread means a good posting is permanently discarded on a bad roll of the dice.

`temperature: 0` did not fix it — 55/78/90 were all at temperature 0. Groq batches
mixture-of-experts models and exposes no seed, so identical requests are not reproducible.
Retrying does not help either: every sample is equally valid, so there is nothing to
detect. The variance had to be designed out rather than retried away.

Two things do that. Narrow factors are questions with observable answers ("does this
posting demand years of experience") instead of a judgement call spread over 100 points,
so there is much less room to disagree. And the arithmetic is deterministic by
construction — same ratings, same score, forever. As a bonus the stored factors explain
every score: a surprising 30 can be read as "location_fit 0" rather than re-litigated.

The gates also fix a separate problem. The old prompt stated the hard rules as prose
("years of experience beats everything else") and the model agreed with them and then
ignored them. Code cannot ignore them.

**Rejected.** *Median of three calls* — mathematically sound, but 3× the calls and ~42
minutes for 30 jobs, and it smooths the symptom while leaving the hard rules unenforced.
*A bigger model* — no evidence 120b is more consistent, and it burns the rate limit that
drafting needs. *Making REJECTED non-terminal* — hides the problem and doubles the scoring
bill every day.

**Cost.** Still one call per job. Weights and gate thresholds are named constants in
`src/match/score.ts`, so calibration can move them without touching the prompt.

**Revisit when.** The calibration gate runs (decision 008). The weights are reasoned, not
measured: if the distribution piles up in one band, the weights are the first thing to
look at, and the stored factors say which one is doing it.

---

## 013 — What the free tier actually costs, and how retries have to behave

**Decision.** Three changes to `src/llm/groq.ts`, all forced by measurements from the first
real scoring runs:

1. A 429's wait is read from the **error body** (`"Please try again in 18.945s"`), not only
   from a `retry-after` header, plus a second of headroom.
2. A retry after a *JSON* failure nudges `temperature` from 0 to 0.3. A retry after a 429
   does not — it is re-sent exactly as it was.
3. `MAX_SCORES_PER_RUN` (60) caps model calls per run; the overflow stays `DISCOVERED`.

**Why.** The free tier's binding limit is **8,000 tokens per minute**, and Groq bills the
*request* as prompt + `max_tokens` — a scoring call with a 2,500-token prompt and
`max_tokens: 1024` is charged 3,570. That is **two scoring calls per minute**, so the third
call inside any minute 429s. Without reading the wait from the body, the exponential
fallback (1s, 2s, 4s) spends all three retries inside the same window and the job is lost
for the day. This actually happened: run 4 lost one of five jobs.

The temperature nudge is subtler. At `temperature: 0` a retry is *not* a fresh roll of the
dice — the request is identical, so a generation that failed schema validation tends to fail
again. One posting failed four attempts in a row, then succeeded on a later identical call.
Retrying only works if something changes, so the retry changes the one thing it can.

**Consequences to plan around.** ~30 seconds per scored job, and roughly two a minute; 60
jobs is about half an hour. That is fine inside a 06:00 cron and is the reason the per-run
cap exists rather than an unbounded loop. If volume grows past that, the cheapest lever is
the prompt: `MAX_DESCRIPTION_CHARS` is ~1,500 of those 2,500 prompt tokens.

**Rejected.** *Raising `max_tokens` for headroom* — it is charged whether used or not, so it
directly reduces calls per minute. *Dropping to one call per minute to never 429* — halves
throughput to avoid an error that is already handled correctly.

**Revisit when.** Gmail-alert ingest lands and the daily queue jumps from 5 to dozens. If
scoring starts dominating the run, trim the prompt before paying for a higher tier.

---

## 014 — Digest shape: silent when empty, HTML not Markdown, a column not a state

**Decision.** Three choices in `src/notify/digest.ts` that look arbitrary and are not:

1. **No message when there are no new matches.** Not even a "nothing today" line.
2. **HTML `parse_mode`, not MarkdownV2.**
3. **`jobs.digested_at` is a column, not a `NOTIFIED` job state.**

**Why.** (1) A daily message that is usually empty trains you to stop opening it, and the
one morning it matters you would swipe it away with the rest. It also breaks idempotency:
two runs in one morning would send two heartbeats. Knowing the *cron* is dead is a different
problem with a different owner — the launchd layer in Phase 3, which can shout when the
pipeline exits non-zero. Silence here means "nothing matched", not "nothing ran".

(2) MarkdownV2 requires escaping fifteen characters, including `.` `-` `(` `)` `!`. Job
titles are made of those: "SDE-1 (Backend)", "Intern — Fall 2026". HTML mode needs three,
`&` `<` `>`. One escaping miss is a 400 from Telegram at 06:05 and no digest at all, so the
mode with a fifth of the escaping surface wins.

(3) Being told about a job changes nothing about the job. It is not on the path from
DISCOVERED to SENT, it does not gate anything, and adding it as a state would mean every
downstream stage has to know that MATCHED and NOTIFIED mean the same thing. Also a job is
legitimately reported *twice* over its life — once as a match, later as a draft awaiting
approval — which a single state cannot express. Phase 2's draft digest gets its own marker
on `outreach`.

**Also.** Ten jobs per digest, remainder held over and reported the next day rather than
dropped — a reading limit, not a rate limit. And `MAX_ITEMS_PER_DIGEST` cuts the *lowest*
scores, since the digest is sorted best-first.

**Rejected.** *`grammy`* — Phase 1 only sends, which is one POST. The library earns its
place in Phase 3, which needs a long poll listening for approve/reject taps.

**Revisit when.** Phase 2 puts drafts in the digest. If the message gets long enough to
split routinely, that is the signal to shorten `reasoning` in the digest rather than raise
the chunk limit.
