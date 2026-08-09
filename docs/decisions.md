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
