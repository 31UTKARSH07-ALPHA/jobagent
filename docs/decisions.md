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

**Superseded in part by 017**, which replaces the flat inter-call gap with an actual token
budget. The measurements and the two retry fixes above still stand.

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

---

## 015 — `@googleapis/gmail`, and the loopback OAuth flow

**Decision.** Gmail access uses **`@googleapis/gmail`**, not the umbrella `googleapis`
package. Authorisation is the **loopback** flow with **PKCE**: a throwaway HTTP server on a
random `127.0.0.1` port receives the `?code=`, and `token.json` is written `0600`.

**Why the per-API package.** `googleapis` installs every Google service — measured at
**206MB**. `@googleapis/gmail` is **1.2MB** for the identical `gmail_v1` client and types.
This project already defers `@huggingface/transformers` over ~500MB of ONNX runtime; paying
200MB for six Gmail endpoints would be the same mistake with less to show for it.

**Why loopback.** It is the only flow Google still supports for a desktop app. The
copy-the-code-into-the-terminal flow (`urn:ietf:wg:oauth:2.0:oob`) was switched off in 2022,
so any simpler-looking approach is a dead end. This is also why `credentials.json` lists
`http://localhost` with no port: desktop clients may use any loopback port, so the server
binds port 0 and lets the OS pick.

PKCE despite the client having a secret, because a secret shipped inside a desktop app is not
a secret — the code exchange is bound to a verifier only the running process knows. `state`
is checked for the same reason: the loopback port is reachable by anything else on the laptop.

**`prompt: 'consent'` is not optional.** Without it, a *second* authorisation returns no
refresh token, and the pipeline silently gets a credential that dies in an hour. `authorize()`
also refuses to write a token that has no `refresh_token` rather than storing one that cannot
survive unattended.

**The trap this cannot fix.** While the consent screen is in "Testing", Google expires the
refresh token after **7 days** — a pipeline that worked all week fails with `invalid_grant` on
day eight. `describeAuthError()` says exactly that, and names the fix, because the alternative
is a future session debugging Google's consent model at 06:05. Publishing the consent screen
is the real fix.

**Revisit when.** Sending starts for real. If the weekly re-auth becomes annoying before
then, publishing the consent screen (or a Workspace account on an own domain, already on the
Phase-3-and-later list) removes it.

---

### 015a — "Published" and "verified" are different things, and only one matters here

Observed 2026-08-23, while fixing the fourth `invalid_grant` in two weeks.

- **Publishing status `Testing`** is what expires the refresh token after **7 days**. This is
  the thing that has broken ingest repeatedly.
- **Verification** is a separate Google review — homepage, privacy policy, demo video — and its
  only effect is removing the "Google hasn't verified this app" warning screen.

So the fix is to set publishing status to **In production** and *not* submit for verification.
The scary screen stays; the weekly token death stops. An unverified production app with
sensitive scopes is capped at 100 users, which is irrelevant for a tool with exactly one.

Clicking `Advanced → Go to … (unsafe)` on that screen is the correct action for the owner of
the app, and will remain necessary at every re-authorisation. That is cosmetic. A token that
dies every 7 days in a pipeline designed to run unattended is not.

The real escape hatch stays what `phases.md` already lists: a Google Workspace account on an
own domain, where this app is *internal* and consents without any of this.

## 016 — Alert emails carry no job description, and that is accepted

**Decision.** Postings from Gmail alerts are stored with `description = ''`. The posting page
is **not** fetched. Everything else — title, company, location, posting id — is parsed out of
the URL slug rather than the visible email text.

**Why no description.** Fetching `naukri.com/jd/...` for each posting is precisely the
scraping that decision 004 rules out; the ban risk is the reason that decision exists, and it
does not stop applying because the request is convenient. So the scorer sees a title, a company
and a location, and its prompt already handles that case explicitly.

**What it costs, stated plainly.** `stack_fit` and `domain_fit` (decision 012) are judged from
the title alone. "Python / AI-ML / Full Stack Developer Intern" carries real signal;
"Software Development Intern" carries much less. Expect alert-sourced jobs to cluster nearer
the middle of the distribution than ATS-sourced ones, which arrive with a full JD. When the
calibration gate runs, **compare the two sources separately** — a single threshold across both
is comparing a rubric applied to two different amounts of evidence.

**Why the URL and not the email text.** Measured on the real mail: the rendered email truncates
the company to "Discover Dollar Tec…", while the slug spells out
`discover-dollar-technologies-pvt-ltd`. The slug is structured — title, company, city,
experience band, id — and the anchor text gives the exact title, so the title's slug can be
*subtracted* from the front instead of guessing where it ends. The remaining
company/city boundary is resolved by matching a known city at the end, never by guessing.

**Consequence to plan for.** Naukri's postings are mostly small companies, so
`resolveCompany` returns `.unknown.invalid` for nearly all of them — 3 of 3 on the first real
run. That is correct (better an honest marker than a wrong domain) but it means Phase 2's
contact cascade has to be able to *find* a domain from a company name, not just assume one
exists. That is now the cascade's first job, not an afterthought.

**What this actually cost, measured the same day.** The first run with Naukri postings scored
all three at **10/10/10/10 → 100** — the same number Stripe's internship got with a full JD
backing it up. Not generosity: with only "Python / AI-ML / Full Stack Developer Intern" to go
on, there is nothing to deduct against, so nothing is deducted. The score quietly stopped
meaning "good fit" and started meaning "the title sounds like me", and 100 is deep inside the
band Phase 3 would auto-send from.

So `clampToEvidence()` holds `stack_fit` and `domain_fit` to **6** when the description is
under 200 characters. A title-only posting now tops out at **82**: comfortably MATCHED, and
permanently below the 85 an auto-send requires. *A posting nobody has read cannot mail
itself.* The prompt says the same thing, but the clamp is what enforces it — decision 012's
lesson was that prose the model agrees with is prose the model then ignores.

**Revisit when.** Reply rates exist. If alert-sourced jobs convert far worse than ATS-sourced
ones, the description gap is the first suspect — and the fix is a better title-only rubric or
dropping those postings, not scraping.

---

## 017 — Pace by tokens, not by wall clock. Refines 013

**Decision.** `src/llm/rate-limit.ts` keeps a per-model trailing-60-second token budget. Before
a request, the client waits until `prompt + max_tokens` actually fits; the reservation is made
*before* the call and reconciled afterwards against `usage.total_tokens`. Each model's limit is
a field on `MODELS` (`tpm`), taken from an observed 429 rather than from documentation.

**Why.** Decision 013 established the arithmetic — 8,000 TPM, ~4,000 tokens a scoring call,
therefore two calls a minute — and then paced with a flat 700ms gap between calls, which knows
nothing about token cost. So the third call in any minute was submitted into an exhausted
window and refused.

Measured across nine scorings on 2026-08-11: **two failed**. One of them by **19 tokens** —
`Limit 8000, Used 4015, Requested 4004`. Retrying works (013), but the run still burns retries
on a failure that was arithmetically certain in advance, and a job that exhausts its retries is
simply lost until the next day. Waiting 200ms is strictly better than being refused.

**Why reserve before the call.** Groq charges the request when it is submitted. Recording usage
after the response would let a second call leave against a budget the first has already spent —
which is precisely the bug being fixed, just moved.

**Why an estimate at all.** No tokenizer: shipping one to size a budget is not worth the
dependency, and the cost of being wrong is a 429 that is already handled. `chars / 3.5` errs
high against the usual 4-chars-per-token rule, and erring high means waiting slightly too long
rather than being refused. The response's real figure replaces the estimate, so a long batch
does not drift.

**Deliberately not fixed.** A request larger than the whole per-minute budget returns a zero
wait rather than hanging — nothing can make it fit, so the 429 handler should see it. And the
700ms floor stays, to stop two calls leaving in the same millisecond.

**Measured after.** Re-scoring the same nine jobs: **9/9 succeeded, zero rate-limit failures**,
in 10m02s — about 67s per job against roughly 30s before. That is the trade being made
deliberately: the pacer converts failures into waiting. Two ~4,000-token calls per minute is the
free tier's ceiling, so ~35 minutes for 30 jobs and ~67 for the `MAX_SCORES_PER_RUN` cap of 60.
Recorded in `architecture.md`'s daily timeline, which previously claimed a 06:05 digest.

This is also what makes the deferred bge-small prefilter worth building as volume grows: it is
the only lever that reduces the *number* of scoring calls, and therefore the only one that
shortens the run materially.

**Revisit when.** A model's limit is seen to differ from `tpm` in a real error. `ASSUMED_TPM`
is applied to the two models whose limits have never been observed; that is a guess, but a
conservative one — too low costs throughput, too high costs a job.

---

## 018 — The schedule is a generated launchd agent driving one shell wrapper

**Decision.** `com.utkarsh.jobagent.daily` runs `scripts/run-daily.sh` at 06:00 local. The
plist is *generated* by `src/schedule/launchd.ts` (`--print` / `--install` / `--status` /
`--uninstall` / `--kickstart`), not committed. Installed and loaded on 2026-08-12 with
Utkarsh's explicit go-ahead.

**Why generate it.** Every value in a plist is absolute and machine-specific: the project
path, the node binary, `$HOME`. A committed plist is one laptop's paths in a file that
silently runs the wrong thing anywhere else — and paths written from memory are the classic
way a scheduled job fails at 06:00 with nobody watching. The generator reads them off the
running process, so `--print` is exactly what `--install` writes.

**Why a shell wrapper rather than node straight from the plist.** The wrapper is the one
entry point both launchd and a human use, which kills "works when I run it, fails on the
schedule" as a category. It also owns the log — a timestamped header per run, the exit code,
and rotation at 5 MB — none of which launchd does. `StandardOutPath` is therefore `/dev/null`
(the wrapper tees into `logs/daily.log`; duplicating it would double every line) and
`StandardErrorPath` catches only launchd-level failures, like a wrapper without `+x`.

**The four things launchd gets wrong if you assume a normal shell:**

- The environment is near-empty and there is no login shell, so `PATH` will not find `node`.
  The plist records an absolute path in `JOBAGENT_NODE`; the wrapper falls back to `PATH`
  only when run by hand.
- `cwd` is `/`. `node --env-file-if-exists=.env`, `data/jobagent.db`, `token.json` and
  `credentials.json` are all relative, so `WorkingDirectory` is load-bearing.
- `process.execPath` is `/opt/homebrew/Cellar/node/25.2.1/bin/node` — a version-pinned path
  that stops existing at the next `brew upgrade`, taking the schedule with it. `resolveNode()`
  records `/opt/homebrew/bin/node` instead, after checking it resolves to the same binary,
  and warns when no stable symlink exists.
- `bootstrap` refuses a label that is already loaded, so `--install` boots out first. That is
  what makes re-installing after an edit a normal thing to do rather than an error.

**`RunAtLoad` is false.** Installing the agent, or logging in, must not fire a pipeline run
and a Telegram digest. The only trigger is the calendar entry, and `--kickstart` when a human
asks for one.

**`StartCalendarInterval`, not `StartInterval`.** A sleeping or shut laptop runs the missed
job on wake. `StartInterval` counts from load and drifts a little further every day.

**No heartbeat here either.** Decision 014 keeps the digest silent when nothing matched, and
noted that a dead schedule is this layer's problem. It still is — but the answer is
`--status` (loaded? last exit code? how many runs?) and `logs/daily.log`, not a daily "I am
alive" message that becomes one more thing not to read.

**What is not covered.** macOS lists the agent under System Settings → General → Login Items
& Extensions. Switched off there, launchd will not run it and nothing in this repo can tell.
The first symptom is a morning with no digest; `--status` will still say `loaded`.

**Revisit when.** Phase 3 adds the 4-hourly tracker — a second `LaunchdJob` object in the
same file, using `StartInterval`, because replies arrive continuously and a missed poll is
not worth catching up on.

### 018a — The project cannot live under `~/Desktop`. Measured, not predicted

The first scheduled run, 2026-08-13 06:00, failed in a way no test caught: **exit code 126**,
before a single line of the wrapper executed.

```
shell-init: error retrieving current directory: getcwd: cannot access parent directories: Operation not permitted
/bin/sh: /Users/utkarshpathak3107/Desktop/jobagent/scripts/run-daily.sh: Operation not permitted
```

macOS TCC protects `~/Desktop`, `~/Documents` and `~/Downloads` per *application*. Terminal
holds that consent, so every hand-run worked — including the `env -i` test from `cwd /` that
was supposed to prove the launchd environment. launchd holds no such consent and cannot even
`exec` a 755 file it can see. The repo moved to `~/jobagent`, which TCC does not protect.

**Why the pre-flight test missed it.** `env -i` reproduces launchd's *environment*. It does
not reproduce launchd's *identity*, and TCC is a question of who is asking, not what is in the
environment. Any future "does it work unattended" check has to run **through launchd** — a
throwaway agent with `--stage=digest --dry-run` in its `ProgramArguments`, kickstarted and
booted out. That test fails with 126 on Desktop and exits 0 from `~/jobagent`; both were run.

**Why not Full Disk Access instead.** Keeping the path would mean granting FDA to `/bin/sh`
and to the node binary — every shell script on the machine, to schedule one job, plus a
re-approval each time Homebrew moves node.

**The tell.** Exit 126 with an empty `logs/daily.log` means the wrapper never ran; the reason
is in `logs/launchd.err`. A wrapper that runs and fails leaves a timestamped header in
`daily.log` instead. Those two logs answer different questions, which is why both exist.

---

## 019 — Wait for the network; never retry your way through its absence

**Decision.** `scripts/run-daily.sh` will not start the pipeline until it can reach the
network, polling every 10s for up to 15 minutes and then **skipping the run** with exit 75
(`EX_TEMPFAIL`). Separately, `getJson` treats a DNS-level error as final rather than
retryable (`isOffline` in `src/ingest/http.ts`).

**Why.** The first two scheduled runs, 2026-08-14 and 08-15, both produced zero jobs:

```
[ingest] source gmail-alert failed: ... getaddrinfo ENOTFOUND oauth2.googleapis.com
[ingest] greenhouse: 0 kept in 992s
[ingest] workable: 0 kept in 1863s
[ingest] done in 3313215ms          ← 55 minutes
```

launchd runs a missed calendar job when the laptop **wakes**, and Wi-Fi associates a minute
or two later. Both runs started ~06:12 rather than 06:00, which is the tell. The same ingest
run by hand with the network up finishes in **38 seconds**.

So the 06:00 run was doing the worst possible thing: 51 boards × 3 attempts against a dead
resolver, an hour of CPU and battery, and a result — zero new jobs — indistinguishable from a
quiet morning. Decision 014 keeps the digest silent when nothing matched, which means this
failure was **completely invisible** from the phone.

**Why skip rather than run anyway.** With no network there is no stage that can do useful
work: every source is HTTP, Gmail is HTTP, Groq is HTTP. A run that cannot work should not
write a `runs` row full of failures — the next morning retries it for free (invariant 4).

**Why exit 75 and not 0.** A skipped run and a genuinely quiet morning must not look the same
in `launchd.ts --status` afterwards. 75 is `EX_TEMPFAIL`: nothing is broken, the conditions
were wrong.

**Why the check fails open.** A missing `curl` skips the *check*, not the run. A gate whose
own failure silently cancels the pipeline every morning is worse than the problem it solves.

**Why `isOffline` too, when the gate already exists.** The gate handles a network that is down
*before* the run; `isOffline` bounds the cost when it drops *during* one. Retrying a DNS
failure retries the network, not the board — and it is the difference between 55 minutes and
seconds. Genuinely transient errors (`ECONNRESET`, `ETIMEDOUT`) keep their retries; that
distinction is what `src/ingest/http.test.ts` pins down.

**Verified through launchd**, not by hand — see 018a for why that is the only test that counts:
a throwaway agent running `--stage=digest --dry-run` exits 0 with the gate in place, and the
offline path exits 75 without writing a `runs` row.

**Revisit when.** If runs start being skipped, 15 minutes is the number to raise — but check
first whether the laptop is simply shut at 06:00, which is a scheduling question, not a
networking one.

---

## 020 — The LinkedIn parser reads the title from the HTML and the fields from the text

**Decision.** `src/ingest/linkedin-alert.ts` takes each posting's **title from the HTML
anchor**, then finds that title in the `text/plain` part and reads the **company and location
from the two lines beneath it**. One entry in `PARSERS`; nothing else changed.

**Why it exists now and not on 2026-08-11.** It was deliberately deferred until real mail
arrived (decision 016's rule). 26 LinkedIn digests had accumulated by 2026-08-16, every one
counted as `alert_unparsed` — the counter did its job, which was to make the arrival visible.

**Why not just count lines.** LinkedIn's text part is a clean stack:

```
Software Intern              ← title
Terralogic                   ← company
Greater Bengaluru Area       ← location
This company is actively hiring     ← a badge, present on some cards and not others
View job: https://www.linkedin.com/comm/jobs/view/4451230158/?trackingId=…
```

Counting lines from the link backwards works until LinkedIn adds a badge, and then the company
silently becomes "Apply with resume & profile" and lands in `companies`, where the Phase 2
contact cascade will try to find a domain for it. Anchoring on the title makes badge changes
cost a *location* at worst. Two badges are known (`actively hiring`, `Apply with resume &
profile`) and the list only has to be right about rejecting.

**Why the HTML for the title.** Each card links its job twice — once from the logo, whose
anchor text is empty, and once from the title. Both hrefs differ only in a `trk=` parameter,
so a naive "first link wins" takes the empty one.

**Unlike Naukri, the URL carries only the job id.** No company, no city (decision 016's slug
trick does not transfer). But that id is worth having: every link carries a per-email
`trackingId`, `midToken` and `otpToken`, so the stored URL is **rebuilt** from the id as
`https://www.linkedin.com/jobs/view/<id>/`. That keeps single-use tokens out of the database
and makes the same job mailed twice look the same both times.

**Loud, not silent.** An email with job links but no readable cards throws, which the source
layer counts as `alert_parse_failed` with the subject attached. A template change must not
present as a quiet week.

**Measured.** First run: alert postings went from 6 to 67, and 29 new jobs entered the DB —
CoinDCX, Sony Research India, Enterpret, Freight Tiger, Sanas. Exactly the Indian companies
decision 010 established have no ATS board at all.

---

## 021 — A source's own id identifies a posting; the hash is for cross-source matching

**Decision.** `upsertJob` looks for an existing row by `(source, source_id)` first, and falls
back to `dedup_key` only when the source cannot name its posting. Migration
`004_source_id_identity.sql` adds the index and repairs the rows that already existed.

**Why.** The LinkedIn parser exposed it immediately: LinkedIn mailed job **4449869353** twice
on 2026-08-16, writing the location as `Bengaluru` in one email and `Bengaluru, Karnataka,
India` in the other. `dedup_key` hashes domain + title + location, so that is two hashes and
two rows for one posting — a wasted 67-second scoring call, and the same job listed twice in
the morning digest.

**Why keep `dedup_key` at all.** It is the only thing that can match the same role *across*
sources — a Greenhouse posting and the LinkedIn alert about it have different ids and always
will. The two mechanisms answer different questions, which is why the order matters: exact
identity first, similarity second.

**Why the index is not UNIQUE.** `source_id` is nullable, and a partial unique index would make
an ingest run *fail* on a duplicate rather than absorb one. Ingest must never fail on data it
can simply recognise.

**Why the repair is conservative.** It keeps the earliest row of each duplicate set — the one
with the truthful `first_seen_at` — and refuses to delete anything referenced by `job_scores`
or `outreach`. Losing an audit trail to tidy up a duplicate is a bad trade.

**Revisit when.** A source starts reusing ids across companies. Nothing observed does; the
`source` column already separates Greenhouse's "5" from Naukri's "5".

---

## 022 — Bound each stage's time, and retry the send. Refines 019

**Decision.** Two changes, from four days of runs that exited 0 and delivered nothing:

1. **Every stage gets a wall-clock budget** (`STAGE_BUDGET_MS` in `src/main.ts`) and an
   `AbortSignal` on `StageContext`. A stage that overruns is abandoned; the run continues to
   the next one and records the overrun in `runs.errors`.
2. **The Telegram send retries** — four attempts at 2s/8s/32s for transient failures, none at
   all for 4xx (`src/notify/telegram.ts`).

**Why.** Decision 019's network gate checks once, at the start. On 2026-08-20 it reported
`network up after 10s` and then DNS went away again mid-run:

```
[ingest] greenhouse: 9 kept in 5s        ← worked
[ingest] lever: 0 kept in 975s           ← 16 minutes of nothing
[ingest] workable: 0 kept in 1013s
[ingest] source gmail-alert failed: getaddrinfo ENOTFOUND oauth2.googleapis.com
[ingest] done in 1994205ms               ← 33 minutes
[score] job 12 failed: fetch failed      ← 27 minutes, for one job
[digest] failed: fetch failed            ← and then the only part that matters
```

Four consecutive digests were lost that way (08-17 to 08-20), and on 08-16 the same pathology
merely delayed one: the run started at 06:08 and finished at **13:24**, so the digest arrived
over breakfast-plus-six-hours.

**Why a budget rather than better timeouts.** `getJson` already caps each request at 15s and
`isOffline` (019) stops retrying DNS failures. Neither helps: 51 boards × 3 attempts is
*entitled* to take an hour, and a hung `getaddrinfo` is not reliably interruptible by
`AbortSignal` at all. The budget is the only thing that can say "this stage has had long
enough", and the digest is the reason it must — it runs last and needs the run to still be
alive when it gets there.

**Why abandon rather than cancel.** A stage that honours `ctx.signal` stops by itself, which
is why ingest checks it between sources and score checks it between jobs. One stuck in an
uninterruptible syscall cannot, so `main.ts` stops *waiting* on it and moves on. The
abandoned promise keeps its own rejection handler, and `node:sqlite` being synchronous means
it cannot be caught mid-write when the DB closes. The CLI then calls `process.exit`, because
an abandoned stage's timers and sockets would otherwise hold the process open for as long as
the thing it was stuck on — which is where the seven-hour run came from.

**Why the score budget is 75 minutes and not 12.** `MAX_SCORES_PER_RUN` is 60 and the pacer
takes ~67s per job (017), so a full queue is ~67 minutes of legitimate work. A tighter budget
would cut a busy morning off mid-run and read as a scoring bug. `main.test.ts` asserts this
relationship rather than the literal number, so changing one forces changing the other.

**Why 4xx is never retried.** Bad HTML in a job title, a revoked token, a wrong chat id: the
message is wrong, and asking again cannot help. Retrying would only delay the error reaching
the log. 429 and 5xx are retried.

**Nothing was lost to the four failed digests**, which is the existing design working:
`digested_at` is set only after Telegram accepts (014), so all 17 matched-but-unreported jobs
were still queued and went out together on 08-20.

**Revisit when.** Budgets start firing on a healthy network — that means the healthy-case
times have moved, and the numbers in `STAGE_BUDGET_MS` are stale rather than wrong.

---

## 023 — Discount the total, not the ratings. Supersedes the clamp in 016

**Decision.** Rubric **v4**. A posting with no description keeps the model's real
`stack_fit` / `domain_fit` ratings, and the missing evidence costs a flat **15% of the
total**, hard-capped at **84** (`EVIDENCE_PENALTY`, `TITLE_ONLY_CEILING`). The prompt now
asks the model to rate what the title implies rather than to hold itself to 6. And
`pendingDigestItems` filters on the newest score, not only on the state.

**Why.** Decision 016's clamp was right about the problem and wrong about the cure. Measured
2026-08-20 across 32 title-only postings:

```
level 10 · location 10 · stack 6 · domain 6  ->  82   ×31
level 10 · location 10 · stack 3 · domain 3  ->  69   ×1
```

An internship title in Bengaluru always earns 10 for level and 10 for location. With the
other two pinned at 6, the score was arithmetic with no inputs left — **31 of 32 identical**.
So `MATCH_THRESHOLD` stopped meaning anything (27 of 29 postings "matched"), and the digest
became a list of every internship-titled posting in India rather than a ranked shortlist. The
JD-backed postings, for contrast, spread properly: 28, 30, 30, 46, 76, 92, 100.

**The clamp also destroyed evidence.** The clamped 6 was what got *stored*, so the model's
actual opinion — 9 for "AI Engineering Intern", 3 for a bare "Intern" — was gone. That is why
v4 needs a full re-score rather than a recomputation: the inputs were never kept.

**What the new arithmetic does**, on real titles from the DB:

```
82  MATCHED   AI Engineering Intern (SpotDraft)
77  MATCHED   Back End Developer - Intern (Janitri)
76  MATCHED   Software Development Intern (Full Stack)
60  rejected  Engineering Intern 3 (Lam Research)
53  rejected  Intern (KLING BREWERY)
49  rejected  Intern Bios Programming (GSK)
47  rejected  Technology Intern (a wedding company)
```

**Why 84 and not 85.** Phase 3 auto-sends above 85, and 10/10/10/10 × 0.85 lands exactly on
85. The ceiling sits one point below it, so 016's real requirement survives intact: a posting
nobody has read cannot mail itself.

**Why the prompt had to change too.** It carried the same instruction as the code — "rate
stack_fit and domain_fit no higher than 6" — so leaving it would have reproduced the flat line
with the clamp removed. It now asks for an honest read of the title, explicitly including a
low one, and says the discount is applied afterwards.

**Why the digest now checks the score.** `MATCHED` is written by whichever rubric was current,
and the state machine has no edge back out of it — `REJECTED` is terminal, deliberately. A
rubric change therefore strands jobs in `MATCHED` that the new rubric rejects; after v4 that
was most of a 33-job backlog, and reporting them would have been precisely the useless-
suggestions failure v4 exists to prevent. Nothing is destroyed: the rows keep their state and
their NULL `digested_at`, so a later rubric that likes them again picks them straight back up.

**Deliberately not done.** No path from `MATCHED` back to `REJECTED`. Terminal states stay
terminal; filtering at the point of reporting gets the same outcome without a state machine
that can change its mind.

**Revisit when.** The v4 distribution exists — that is the calibration gate (008), still open,
and now with a score that varies enough to calibrate against.

---

## 024 — Calibration: `MATCH_THRESHOLD` stays 70. Closes 008

**Decision.** Keep `MATCH_THRESHOLD = 70`, now on evidence rather than as a placeholder. The
v4 distribution across 39 jobs, 2026-08-20:

```
 30 ###                            has JD, n=7    range 30-100  avg 56.9
 46 #                              title only, n=32  range 47-84  avg 76.3
 47 #####
 64 #                              at 70: 29 of 39 match
 70 ##                             tied at the 84 ceiling: 22 of 39 (56%)
 76 #                              v3, for comparison: 30 of 38 tied at 82 (79%)
 77 #
 78 #
 84 ######################
 86 #
100 #
```

**Why 70 and not higher.** The band it rejects is genuinely junk, and the rejections are the
right ones — "Intern Engineer", "G - Trainee engineer", "Engineering Intern 3" (Lam Research,
hardware), "Intern Bios Programming" (GSK). The band it accepts is genuinely plausible: Sony
Research India, Sanas, Freight Tiger, Enterpret. Moving the line to 75 would gain nothing —
there is nothing between 70 and 76 — and moving it to 80 would drop the four postings at 76,
77, 78 that a human would want to see.

**What is still wrong, stated rather than hidden.**

1. **22 of 39 tie at exactly 84.** Better than v3's 30 of 38 at 82, but the digest still
   orders a 22-way tie by `first_seen_at`, which is arbitrary. This is now
   *information-limited, not rubric-limited*: "Software Engineering Intern",
   "Full Stack Developer Intern" and "AI Research Intern" really are equally good matches as
   far as a title can tell. Squeezing more spread out of that input would be inventing
   precision. The fix is more evidence, not a finer scale.
2. **v4 introduces false negatives on bare-but-real titles.** Two examples held back from the
   first v4 digest:

   ```
   47  Intern - Engineering        | CoinDCX
   64  Intern – Kotlin Developer   | SmartQ
   ```

   CoinDCX is a real engineering shop and that internship is probably a good fit; the title
   simply does not say so, and the model rated `stack_fit` 0 for the absence. This is the
   cost of the trade — v3 accepted everything, v4 rejects some things worth having.
3. **The rubric has no company signal at all.** `domain_fit` rates the *problems*, not the
   employer. For a title-only posting the company name is the only other evidence available,
   and a bare "Intern - Engineering" at CoinDCX is worth more than a bare "Intern" at a
   brewery. `data/companies.json` already knows which companies are engineering companies.
   **This is the most promising next lever** and it addresses (1) and (2) together — it is
   also new information rather than a re-weighting of the same inputs.
4. **`level_fit` does not know about returnships.** "ReStart Consultant (Software Engineering
   Return...)" scored `level_fit` 10; it is a programme for people re-entering work after a
   career break, not a student internship. India has several (Amazon Rekindle and similar).
   One line in the prompt fixes it — deliberately **deferred to the next rubric bump** rather
   than spending a version and a 40-minute re-score on a single posting.

**Revisit when.** A company signal exists (3), which is a rubric change and therefore v5.
Re-check the threshold against that distribution rather than assuming 70 carries over.

---

## 025 — The fixes in 019 and 022 each had a hole. Both were in the ordering

**Decision.** Three changes, from three more silent mornings (08-21, 08-22, 08-23):

1. **The network gate checks every host the run depends on**, not one:
   `api.telegram.org`, `api.groq.com`, `oauth2.googleapis.com`.
2. **Alert email is polled first**, and **each source gets its own 3-minute budget**
   (`SOURCE_BUDGET_MS`) under the stage budget.
3. **The digest budget is 8 minutes, not 5**, and the send stops retrying once its stage has
   been abandoned.

**Why the gate was not enough.** 019 waited for `oauth2.googleapis.com` and then trusted the
network. Measured on 08-23: `network up after 10s`, and then

```
[ingest] warn: lever/anyscale: stage exceeded its 12 min budget
[ingest] lever: 0 kept in 1048s
```

DNS came back **for some names and not others**. One host resolving proves nothing about the
rest, and node's `AbortSignal.timeout` does not interrupt a stuck `getaddrinfo` — which is why
a 15-second request timeout produced a 17-minute source. `curl --max-time` does cover the
lookup, so the gate is the right place to test it, and it now tests everything that costs a
whole stage. Board hosts are deliberately excluded: a dead ATS is normal and costs one source.

**Why the stage budget was not enough.** 022's budget says *when* to stop, not *who got the
time*. Lever spent the entire 12 minutes, so ingest never reached the two sources after it:

```
[ingest] out of time — skipped ashby and any source after it
```

Alert email was last in the list and supplies **67 of 76 postings** — the run was reliably
starving its best source to feed five boards that were not answering. So sources are now
ordered best-first, and no single source can spend more than three minutes of a
twelve-minute stage. A healthy source finishes in under thirty seconds.

**Why the digest budget was actively harmful at 5 minutes.** Four attempts × a 20s request
timeout plus the 2+8+32s ladder is ~122s per message part, and a ten-match digest is two or
three parts. The budget was killing the retries it was supposed to allow — three digests died
mid-ladder with `send_retry: 2`. And because attempts kept running after the stage was
abandoned, two of them logged *after* `[digest] failed`, against a stage nobody was waiting
on. The send now takes the stage signal and stops.

**The pattern worth naming.** Every fix in 019, 022 and 025 was correct and incomplete in the
same way: it bounded the thing that had just failed, without asking what would then fail
first. A budget without an ordering starves the tail; a gate on one host says nothing about
the next. When adding a limit, check what it makes the *new* bottleneck.

**Measured after.** A full `--dry-run` pipeline: **30 seconds**, with alert email attempted
first, all four ATS adapters polled, and the digest rendered. Lever, Ashby and Workable still
fail from this network at times, and now cost seconds rather than a morning.

---

## 026 — A failure alert, which is not the status ping 014 refused

**Decision.** `src/notify/health.ts` sends one Telegram message when something is **newly**
broken, and nothing otherwise. `StageContext` gains `fault(message)` so a stage can record a
non-fatal problem with its identity attached; `runIngest` uses it for a dead source. Called
from `main.ts` after `finishRun`, so one message covers the whole run.

**Why, when 014 said no.** 014 refused a *heartbeat* — a daily "all fine" you stop reading,
and which is then worse than nothing because it looks like coverage. That reasoning holds. But
014 also said "a dead cron is the launchd layer's problem", and three weeks of evidence says
that layer cannot see most of what breaks:

| Broken | Found | How |
|---|---|---|
| no network at 06:00 | 2 days later | reading logs |
| no stage deadline (7-hour run) | 4 days later | reading logs |
| digest could not send | 4 days later | reading logs |
| **Gmail token expired** | **4 days later** | reading logs |
| the score was a constant 82 | 2 weeks later | reading the DB by hand |

Every one exited 0. Every one was recorded perfectly. Nobody looked, because looking requires
suspecting — and the digest's silence when nothing matched (014, still correct) makes a dead
morning and a quiet one identical from the phone.

**What makes it not a heartbeat.** It is silent on a healthy run, and silent on an *unhealthy*
run whose faults were already reported. A credential expired for a fortnight costs **one**
message. So the message arriving means something new happened, which is the only property that
makes an alert worth reading.

**The dedupe compares fault identity, not text.** `signature()` strips digits, so "exceeded
its 12 min budget" and "exceeded its 8 min budget" are one ongoing problem rather than two,
and a message carrying a job id does not re-alert every morning. It keys on the stage too: the
same words from `ingest` and from `digest` are different problems.

**Dry runs are excluded from the baseline.** A `--dry-run` in the afternoon must not silence
the next morning's real alert.

**Why `fault()` rather than a counter.** `source_failed: 1` was all the DB knew while Gmail
sat expired — a count says how many, never which or why. `fault()` carries the message, so the
alert can say `invalid_grant` and name the command that fixes it.

**It never throws.** It runs at the very end of the pipeline, and a failure to report a failure
must not become the thing that breaks the run.

**Deliberately not done.** No "recovered" message. The next digest full of new jobs is the
recovery signal, and a second message class doubles what there is to get wrong.

**Verified against the real thing:** a healthy ingest run reports nothing; the same run with
`GOOGLE_TOKEN_PATH` pointed at a missing file produces the alert, with `run: node
src/gmail/auth.ts` already in the text.

---

## 027 — Freshest first, and no unpaid postings

**Decision.** Two changes to what reaches the phone:

1. `pendingDigestItems` orders `fit_score DESC, first_seen_at **DESC**` — newest first within
   a tie, the opposite of before.
2. `isUnpaid` in `src/ingest/filter.ts` drops postings that say in their own title that they
   do not pay. Applied at ingest for new postings, and in the digest query for ones already
   stored.

**Why the ordering was actively harmful.** 57 of 90 v4 scores land on exactly 84 (024), so
within that tie the *tiebreak* decides what Utkarsh reads. With 46 matches queued against
`MAX_ITEMS_PER_DIGEST` of 10, that is five days of digests. Oldest-first sent a posting found
this morning to the back of that queue — and an internship found five days ago may well be
closed. For a job hunt, staleness is the cost that matters; between two postings the scorer
cannot separate, the newer one is strictly the better bet.

**Why unpaid postings need a filter and not a lower score.** "Frontend Web Developer
Antigravity Intern- NON PAID" scored **78** and "6-Month Unpaid Internship — Forward-Deployed
Engineer" scored **70**. Both are correct scores: the *role* genuinely matches the stack, which
is all the rubric is asked about. Pay is a different question, the answer is sitting in the
title, and a regex is cheaper and more reliable than teaching the rubric about money.

`UNPAID_TITLE` is deliberately narrow — only an explicit statement counts. Most paid
internships never mention pay, so reading a missing salary as "unpaid" would drop nearly
everything.

**Why the digest filters as well as ingest.** Ingest stops new ones. The two already stored are
`MATCHED`, and `REJECTED` is terminal so there is no legal way back (023's reasoning). The
filter runs in JS rather than SQL so `isUnpaid` stays the single definition: SQLite has no
`REGEXP`, and a `LIKE` list would be a second copy that drifts.

**The trade this creates, stated rather than discovered later.** Newest-first starves the tail
the way oldest-first starved the head. Sony Research India's AI Research Intern — a posting
worth having — is now behind five days of newer 84s, and if daily intake keeps pace with
`MAX_ITEMS_PER_DIGEST` it may never be sent. That is the better failure of the two, because the
starved end is the end most likely to be closed anyway. But it is a real cost, and the honest
fix is not a third ordering: it is either a bigger digest, or a queue that **expires** unsent
matches after about a week instead of pretending they will get their turn. **Not settled — see
`agenthandoff.md`.**

---

## 028 — A deadline only works where it is actually plumbed

**Decision.** `searchEmails` takes the caller's `AbortSignal`, passes it to every Google
request, and checks it between messages. `gmailAlertSource` hands it `ctx.signal`.

**Why.** 2026-08-24, the morning after 025 supposedly fixed exactly this:

```
[ingest] alert email first, then 51 companies across 4 boards
[ingest] failed: stage exceeded its 12 min budget
[ingest] done in 1014884ms
```

Not one source line. Ingest hung inside the *first* source and never came out. 025 gave every
source a 3-minute budget — but a budget is an `AbortSignal`, and `src/ingest/gmail-alerts.ts`
never looked at one. The signal was plumbed into `getJson`, which the ATS pollers use, and not
into the Gmail path, which goes through `@googleapis/gmail`.

**The part worth remembering.** 025 also moved alert email to the *front* of the queue, because
it is the most valuable source. That was right, and it made this worse: the one source with no
deadline became the one everything else waits behind. A correct change and an unnoticed gap
combined into a run that did nothing at all.

Same shape as 025's own lesson, one level down: bounding a thing only bounds the paths you
actually bounded. **When adding a deadline, check every I/O path underneath it, not just the
one that failed.** `src/llm/groq.ts` has its own `fetch` and is the remaining unplumbed path —
scoring's 75-minute budget cannot stop a hung Groq call today. Written down rather than left
to be rediscovered.

**What did work that morning**, recorded because it is the first time: `[health] reported 2 new
problem(s)`. The pipeline told Utkarsh it was broken on the morning it broke, without anyone
reading a log (026). Every previous failure took two to fourteen days to find.

---

## 029 — The last unplumbed path. Closes the loop 022 opened

**Decision.** `ChatOptions` takes an `AbortSignal`; `chat` checks it before each attempt,
**inside the rate-limiter's wait**, and on the request itself; `complete` checks it around its
schema retries; `Scorer.score` takes it and `runScore` passes `ctx.signal`.

**Why.** 028 named `src/llm/groq.ts` as the remaining path with no deadline and said it had not
bitten yet. It bit the next morning:

```
[score] scoring 3 of 3 waiting
[score] job 96 failed: fetch failed
[score] failed: stage exceeded its 75 min budget
[score] done in 10300306ms          ← 2.9 hours, three jobs
```

Every network call in this project now flows through something that honours a deadline —
`getJson` for boards (022), `searchEmails` for Gmail (028), `sendMessage` for Telegram (025),
and this. That closes the class of bug 022 opened and 025 and 028 each partly fixed.

**The rate-limiter wait is the important one.** A scoring run legitimately spends most of its
time asleep, waiting for token headroom at two calls a minute (017) — so that sleep is exactly
where a stage will be sitting when it runs out of time. A guard only before the request would
have left the common case unbounded.

**`stop()` is a function, not an inline check.** TypeScript narrows a repeated
`opts.signal?.aborted === true` to `false` after the first one, having no idea the value flips
while the loop sleeps. The compiler was right that the code as written was unreachable, and
wrong about why.

**The pattern, now four entries long** (022 → 025 → 028 → 029): a limit bounds only the paths
you actually plumbed, and each fix moved the bottleneck to the next unplumbed one. The general
lesson is cheap to state and was expensive to learn: **when adding a deadline, enumerate every
I/O call underneath it, then check them off.** There is no fifth path today — but the next new
network call is one, and it will not announce itself.

---

## 030 — A guessed domain is fine; a believed one is not. The two gates

**Decision.** The contact stage starts by turning a company *name* into a real domain, and
nothing is stored unless it clears both of:

1. the domain publishes MX records (`src/contacts/verify.ts`), and
2. the live page, fetched and stripped to text, contains the **whole** normalised company
   name (`pageNamesCompany` in `src/contacts/domain.ts`).

Candidates come from URL heuristics first — the name stripped of legal suffixes, crossed with
`.com .in .ai .io .co .co.in .app .tech`, plus a hyphenated form and the first word alone,
capped at 12 — and only names that survive all of them go to Groq. Whatever Groq answers is
put through the identical two gates.

**Why this comes before the cascade at all.** `phases.md` lists `cascade.ts` as Phase 2's
first task, and it cannot be: **73 of the 78 matched jobs belong to a company whose domain is
an `.unknown.invalid` marker** (decision 016), all from alert mail, whose posting URLs are
`linkedin.com` and `naukri.com` and carry no company domain anywhere. Every rung of the
cascade keys off a domain, so without this the stage would run and find nothing for 94% of
the queue.

**What the two gates actually caught.** Measured over the 69 real unknown companies in the DB:

| | |
|---|---|
| Resolved | **59 of 69 (86%)**, 58 by page proof |
| Rejected by MX | `berryworks.com` (an atom.com sale listing), `stancehealth.com` (HugeDomains) |
| Rejected by name | `chai.com` for Chai Point, `stance.com` for Stance Health, `erm.com` for Sustainability Economics |

Both parked domains resolve and serve real HTML. Without the MX gate they would have been
adopted, pattern-guessed to `careers@berryworks.com`, drafted, and — in Phase 3 — sent. The
bounce is the damage: Gmail scores the account on bounce rate, and this project has one
personal address, no sending domain and no warm-up to spend (decision 011's $0 budget).

**The first-word stem was accepted at first, and was wrong every time it decided anything.**
Chai Point → `chai.com`, Stance Health → `stance.com`, Sustainability Economics → a
consultancy called ERM. All three were pages containing an ordinary English word. The rule is
now the whole name, which works only because `normaliseCompanyName` already strips the "Pvt
Ltd"/"Technologies" noise the alert mail adds — "Discover Dollar Technologies Pvt Ltd" merely
has to find `discoverdollar`, which is what the site says.

**Redirects are resolved to the apex, and that is load-bearing.** `chaipoint.com` redirects to
`shop.chaipoint.com`; an earlier version stored the landing host, asked whether *that* had MX
— subdomains almost never do — and discarded the right answer, falling through to `chai.com`.
`apexOf()` also decides the never-a-company blocklist, because a dead company site commonly
redirects to LinkedIn, and recording `linkedin.com` as a company's domain would be a
first-class catastrophe.

**One weaker proof exists, and it is narrow on purpose.** `coindcx.com` accepts mail and 403s
every request behind a bot filter, so the page test can never pass — and 024 named CoinDCX
specifically as a posting this pipeline should be reaching. So a domain that (a) refused to be
read with an HTTP status, (b) has MX, and (c) spells the company name **exactly** is accepted
as `proof: 'exact-domain'`. It is held back rather than returned: taking it immediately
resolved FRND to `frnd.io`, three candidates ahead of `frnd.app`, which is the company and
says so on its home page. A weaker proof must lose to a stronger one found later, so the
candidate loop always runs to the end.

The blast radius of being wrong is bounded by construction: with no readable page there is
nothing to scrape, so such a company can only ever produce a pattern-guessed address, which is
`confidence: 'low'`, cannot auto-send (invariant 3), and is read by a human first.

**The model fallback barely earns its place, and is kept anyway.** Over the 12 names the
heuristics missed it rescued **one**, CoinDCX, which the weak path had already found. It
correctly refused to answer for ten. That is the right behaviour and it costs ~10 small calls
a run, so it stays — but do not expect more from it, and do not put it first: heuristics are
free and instant, and Groq's 8,000 tokens/minute are already scoring's bottleneck (017).

**It is the one Groq call in this project with no Zod schema.** With
`response_format: json_schema`, Groq returned `400 Failed to validate JSON` for 10 of those 12
names — precisely the ones where the honest answer is "I don't know". Strict mode rejects the
model's way of expressing an empty answer, so the schema was converting *correct refusals*
into errors. A bare domain needs no schema; a regex parses and validates it in one step.

**Unresolved is a real outcome, not a failure.** Ten companies stay on their markers. Those
jobs go to `NEEDS_CONTACT` and retry every 3 days, 3 times, then `EXPIRED` — the path the
state machine already specified. No email is ever drafted against an unverified domain.

**Revisit when.** The miss list is dominated by companies whose site is a JS shell or whose
name is a division ("Sony Research India"). If that list grows, the next lever is reading the
`<title>` of a `/about` page rather than loosening the name rule — loosening it is what
produced `chai.com`.

---

## 031 — The contact cascade, and the two addresses it should never return

**Decision.** `src/contacts/` is now a real stage: resolve the domain (030), run four rungs
best-first, MX-check the winner, store one contact per **company** (decision 005), and advance
every waiting job at that company to `DRAFTED` — or to `NEEDS_CONTACT`, retried every 3 days,
3 times, then `EXPIRED`.

The rungs, and the confidence each earns, are the ladder invariant 3 rests on:

| Rung | Confidence | Auto-send eligible |
|---|---|---|
| `posting` — an address in the job description | high | yes |
| `team_page` — an address published on the company's own site | high | yes |
| `github` — the company's GitHub org public email | medium | no |
| `pattern` — `careers@` and friends, guessed | low | no |

**First real run, 2026-08-25:** 5m45s, 0 errors, 78 companies. 67 jobs to `DRAFTED`, 11 to
`NEEDS_CONTACT` — exactly the 10 companies whose domain would not verify. 27 addresses came
from a real page, 1 from GitHub, 34 are guesses. Every stored contact has MX.

**Two addresses got through that should not have, and both were high confidence.** That is
the part worth remembering, because `high` is the tier Phase 3 may auto-send without a human
ever reading it:

- **The wrong desk.** `customercare@chaipoint.com` and `support@bytebeam.io` were returned as
  `team_page` finds. A cold job application arriving in a customer-service queue is how a
  small company decides a sender is spam. Every customer-facing desk now joins `sales@` and
  `billing@` on the junk list, and those companies fall through to a `careers@` guess — which
  is `low`, so a human reads it first. Losing a real address to gain an approval step is the
  right trade at this tier.
- **Another company's mailbox.** The aggregator "Top Gen AI Jobs" publishes
  `jobs.accommodations@sandisk.com` on its site, and the rule "off-domain is fine if the local
  part is about hiring" stored SanDisk's *disability-accommodations* inbox as a high-confidence
  contact for a different company. **A page can name any address it likes; that does not make
  it the page owner's.** Off-domain addresses are now kept only from mailbox providers
  (`gmail.com` and friends — which is genuinely how a ten-person firm in Kochi operates), or
  when the local part carries this company's own name. `accommodations@` and `accessibility@`
  are junk outright.

The generalisation, and it is the same shape as 025 and 028: **a filter written for the common
case will be applied to the adversarial one.** Both bugs were rules that were correct about
the address and wrong about whose it was.

**Why `mx_valid` is always 1.** An address whose domain fails the check is never stored — the
cascade walks down its ranked list until one answers. The column records that the check
happened, not its outcome.

**Why the MX check is a parameter.** `bestContact` takes its checker as an argument. A stage
test that stubbed the cascade but not this sat there resolving `acme.com` against the real
internet, which is a slow test today and a flaky one on a plane.

**One-off DB repair, 2026-08-25.** Job 30 was reset `DRAFTED → MATCHED` by hand to re-run it
after the SanDisk fix, and the bad contact row deleted. Safe only because no `outreach` row
existed. The state machine has no such edge on purpose — this is the same category of
intervention as the 2026-08-10 reset, and no stage may ever do it.

---

## 032 — Drafting: plain text into Gmail drafts, and the digest as the review queue

**Decision.** `src/draft/` composes the email with Groq and writes it into Gmail with
`drafts.create` — never `messages.send`, from anywhere, ever (invariant 1). The digest then
carries the drafts, which is what makes them get read.

**First real run, 2026-08-25:** 8 drafts written into the account in 128 seconds, 0 errors, 0
sent. `UNIQUE(job_id)` on `outreach` means a job can have one draft ever; the stage skips any
job that already has a row rather than relying on the constraint to catch it.

**Order of operations is load-bearing.** The Gmail draft is created *before* the `outreach`
row is written. Reversed, a Gmail failure would leave a row claiming a draft that does not
exist — and `UNIQUE(job_id)` would then block the retry that would have fixed it. As written,
a failure leaves no row at all and tomorrow tries again.

**Three things the model got wrong before this was usable**, all found by running it rather
than by reading it:

1. **Structured output 400s on an email.** Asked for `{subject, body}` under strict JSON
   schema, Groq returned `400 Failed to generate JSON` on two of the first three real
   postings. A body is a long multi-line string, which is the hardest thing for strict mode
   to emit. Now it replies as `Subject: …` + blank line + body, parsed with a regex and a
   slice. Second time this project has had to back out of structured output for a
   text-shaped answer — see 030.
2. **The model spent its budget thinking.** `gpt-oss-120b` used **774 of 900 tokens** on
   reasoning and returned a truncated email, which reached the draft checker as "too short to
   say anything" rather than as truncation. `reasoning_effort: 'low'` cuts that to **15
   tokens**, and a draft now takes 1.8s instead of 55s. Separately, `finish_reason: 'length'`
   is now an error in `src/llm/groq.ts` rather than a silently half-written result — that
   affects the scorer too.
3. **It wrote "As a final-year student", which his resume does not say.** The claim came from
   `job_scores.reasoning`, which is written in the rubric's voice ("a final-year student can
   take this role") and was being passed in as context. The reasoning is no longer sent, and
   `problemsWith()` rejects a year-of-study claim that does not appear in the profile.

**Generated is not the same as send-worthy.** `problemsWith()` runs on every draft and rejects
placeholders, an unsigned email, an unnamed company, invented employment, and invented dates;
a rejected draft is regenerated **once with the specific complaints attached**, because Groq
has no seed (012) and a blind retry is a coin flip while a named fault is something to correct.

**No `From` header.** `data/profile.json` holds his college address and the authorised account
is his personal Gmail. Gmail honours a `From` only for a verified alias, and checking that
needs `gmail.settings.basic` — a scope 015 deliberately did not take. Omitted, Gmail fills in
the account that can actually receive the reply.

**The digest needed a second marker, exactly as migration 003 predicted.** `jobs.digested_at`
reports a job once ever, so a job reported as a match on Monday and drafted on Thursday would
have its email written and never mentioned to anybody — and with a 67-job backlog against 8
drafts a run, that is most drafts. Migration 005 adds `outreach.digested_at`, set only after
Telegram accepts the message, the same idiom and for the same reason.

**A draft shown inline under its own match is not repeated in the drafts section**, and the
`(guessed)` label appears on every low-confidence address, every time. That label is the only
thing standing between a pattern guess and the assumption that an address was verified.

---

## 033 — Every email opens with a greeting, and never with a name we guessed

**Decision.** A draft must open with `Hi <first name>,` when the **posting itself** named a
person, and `Hi <Company> team,` otherwise. No `Dear Sir/Madam`, no `Dear Hiring Manager`, and
no name inferred from anything but the posting. Checked in `problemsWith()`, not just asked
for in the prompt.

**Why it came up.** Utkarsh read the first eight drafts and asked whether opening with no
greeting was acceptable. It was not, and the measurement made the answer sharper than the
question: **seven of eight opened mid-sentence and one said "Hi Stripe Team,"**. The
inconsistency was the real finding — the format had never actually been specified, so the
model was choosing per call.

The cause was an ambiguous instruction of ours, not a misbehaving model. The old rule said
*"open with the hook you are given, not with 'I am writing to express my interest'"*, which
reads perfectly well as "the hook is line one".

**Why a greeting rather than none.** No greeting is the most recognisable signature of a mass
mailing, which is the impression this entire project is arranged to avoid — sends are jittered
(007), volume is capped and ramped, and every email is personalised per company. Three words
buy consistency with all of that. But *formal* is the wrong correction: `Dear Sir/Madam` is
itself the opening of bulk mail, so it is rejected explicitly rather than left to taste.

**Never invent a name.** Utkarsh's instruction, and it closed a real bug: the GitHub rung was
storing the **company** name in `contacts.name`, a field that means *a person*, so the new
greeting logic would have written "Hi Convin," as though Convin were somebody's first name. A
personal greeting is now gated on `source = 'posting'` — the only rung where a name could have
come from a human writing it down. Everything else gets the company greeting, which is a
perfectly normal thing to receive.

**`greetingName()`, and why it is not `normaliseCompanyName()`.** The first fixed pass wrote
"Hi Discover Dollar Technologies Pvt Ltd team," and "Hi AI4SEES Private Ltd team,". The
existing normaliser would have fixed that and also lowercased the name and stripped
"Technologies" and "Labs", which are part of how companies refer to themselves. So a second,
narrower function removes only legal-entity suffixes and keeps the original casing.

**The hook is a résumé bullet and must not be pasted in as one.** `job_scores.hook` is written
as "Built a distributed suggestion engine achieving p95 8 ms latency", and the drafter used it
verbatim — so an email opened `Built a distributed…`, a sentence with no subject. It must be
rewritten in the first person, and the checker rejects an opening sentence that begins with a
bare past participle.

**`--redraft`, the counterpart to `--rescore`.** A prompt improvement is worth nothing to the
drafts already written, and `UNIQUE(job_id)` guarantees the stage will never revisit them.
`node src/draft/index.ts --redraft` recomposes every unsent draft and rewrites it in Gmail
with `drafts.update`, keeping the draft id — which is the handle that makes an ambiguous send
answerable later (007), so delete-and-recreate is not an option. It never touches a sent email
and never touches state.

---

## 034 — Claims are traced to artifacts, not to the resume's adjectives

**Decision.** Every quantitative claim the pipeline can put in an email was checked against the
source repository it describes, and `data/profile.json` was corrected where the artifact did
not support the wording. Two projects were renamed away from "Distributed".

**Why this is a pipeline concern and not a resume concern.** It is both, but the pipeline is
what makes it urgent: the chain is

```
resume PDF → data/profile.json → job_scores.hook → the email
```

and at the time of checking, **8 of 8 drafted emails and 63 of 95 stored hooks** opened on a
"distributed" claim. One sentence from the resume was about to become two-thirds of everything
this system says about him. The drafter is not at fault — decision 032's checker stops it
inventing claims, and it was faithfully repeating the profile. **A checker that verifies the
model against the resume cannot catch a resume that overstates.**

**What the repositories actually showed** (`Search-TypeAhead-System`, `Distributed-Cache-System`):

| Claim | Artifact | Verdict |
|---|---|---|
| p95 8 ms / p99 ~11 ms on `/suggest` | JMeter: p95=8, p99=11, mean=4.62, 1,800 samples, 0 errors | exact |
| 150K rows → 1.88M prefix entries | 150,000 rows loaded; full build confirmed by Utkarsh | kept |
| Redis Cluster, consistent-hash ring | `--cluster create` over 6 nodes, `--cluster-replicas 1` → 3 masters + 3 replicas, one host | real, but single-host and never failure-tested |
| "Reduced DB writes by 5×" | **measured write-reduction factor 1.08** in his own `CHANGES.md` | **removed** |
| "Distributed" cache, 1M+ ops/sec | no sockets, no RPC — nodes are objects in one JVM | renamed to "Sharded"; the benchmark figure was already honest |

The 5× was the dangerous one and nobody was looking at it. It appears to be a misreading of
the exercise's own traffic spec (`PROBLEM.md`: *"Typeahead API requests/second (peak, 5x)"*).
The mechanism is real — the aggregator does collapse repeated queries in a flush window — but
the benchmark used mostly distinct prefixes, so there was nothing to collapse. The profile now
states the **mechanism with no multiplier**, which is true under any traffic mix.

**Precision reads as competence, not modesty.** "6-node Redis Cluster (3 masters, 3 replicas,
single-host Docker), hand-rolled consistent-hash ring mapping prefixes to hash-tag buckets" is
longer than "distributed typeahead system" and *stronger*, because every clause is checkable
and it demonstrates knowing why the ring exists at all — Redis Cluster rejects multi-key
operations across slots, so the ring groups prefixes into hash tags to make index writes
pipelineable. That is the answer to the obvious interview question, and it only exists once
the claim is specific.

**`data/profile.json` is generated and gitignored — these edits are not in version control.**
`node src/match/profile.ts` re-extracts it from the resume PDF and will silently overwrite
them. The durable fix is the **PDF**, which is also what a recruiter reads beside the email;
if the two disagree, the email is the one that looks invented. This entry is the only record
of what was changed and why.

**Scores move when the profile does.** Job 78 was re-scored against the corrected profile and
landed on exactly 70 — the match threshold. A full re-score after the resume is updated will
shift the distribution, so re-check `MATCH_THRESHOLD` against it (decision 024) rather than
assuming it carries over.

**Historic hooks are left alone.** One v3 row still carries the 5× wording. `job_scores` is
keyed on `prompt_version` precisely so history survives (008), and the digest and drafter both
read the newest score per job, so it is never used. Rewriting it would be falsifying the record
of what the pipeline believed at the time.

---

## 035 — Trusted addresses only, until guesses prove themselves

**Decision.** `DRAFTABLE_CONFIDENCE` in `src/draft/index.ts` is `['high', 'medium']`. Pattern
guesses are not drafted at all for now. One constant turns them back on.

**Why, in Utkarsh's words (2026-08-28):** send the trusted ones, try guesses later, and if the
guesses produce no replies, stop making them and focus on real addresses.

**Why it gates drafting and not just sending.** Sending is where the bounce risk lives, so the
send gate is the obvious home — but the drafts are also his **review queue**, and a queue full
of emails he has already decided not to send is a queue he stops opening. Drafting only what
he would send keeps the morning list worth reading.

Current split: **27 undrafted jobs reachable via a published address, 32 only via a guess.**
So this costs nothing in the short term — there is a week of trusted work queued ahead of the
first guess.

**What would settle it.** Reply rate on published addresses versus guessed ones. Note that
~50–100 sends are needed before a reply rate means anything at all: cold outreach runs 1–10%,
so zero replies from the first eight is the *expected* result even when everything works. Do
not conclude anything from the first batch.

---

## 036 — An hourly fast lane, because the daily poll was half the delay

**Decision.** A second launchd agent, `com.utkarsh.jobagent.hourly`, runs
`ingest → score → alert` every hour. Contacts, drafting and the digest stay at 06:00. A new
`alert` stage sends an immediate Telegram message for anything scoring ≥ 85.

**Why.** Utkarsh noticed he hears about postings a day late, by which time a hundred people
have applied. Measured rather than assumed — `posted_at` for an alert-sourced job is the
*email's arrival time*, so the gap to `first_seen_at` is our own latency and nothing else:

| Ingest day | Median | Max |
|---|---|---|
| 2026-08-23 | 73.8h | 155.8h |
| 2026-08-24 | 3.3h | 6.2h |
| 2026-08-25 | 4.0h | 4.0h |
| 2026-08-28 | 12.3h | 12.3h |

The 08-23 row is the catch-up after the expired Gmail token, not steady state. **Healthy, our
own delay is 3–12 hours and can reach 24** — entirely because the poll ran once a day. Hourly
polling recovers it. A full fast-lane run takes **44 seconds**.

**What this does not fix, and it is the larger half.** LinkedIn and Naukri send *daily
digests*. A posting is already a day old before its alert email exists, and no polling rate
touches that. **The only channel where being early is achievable is a company's own ATS
board**, which lists a job the minute it is published — which makes expanding
`src/ingest/candidates.ts` a freshness decision, not just a coverage one (decision 010).

**Why the alert is separate from the digest, and rare.** `ALERT_THRESHOLD` is 85: the
auto-send band from 006, and one point above the title-only ceiling of 84 (023) — so an alert
can only ever fire for a posting whose full description was read. Under rubric v4 that is 1 job
in 91. An hourly ping that fires often is one he learns to swipe away, which is decision 014's
argument against a status ping. An alerted job is marked digested, so the morning digest never
repeats it: one job, one message, whichever stage gets there first.

**`StartInterval`, not a calendar entry.** A missed hourly poll costs an hour of freshness and
nothing else, so there is nothing to catch up on at wake — the opposite of the daily run, which
must not be skipped (018).

**Two things the second agent forced, and both were latent bugs.** `run-daily.sh` had no lock,
so an hourly run landing on 06:00 would have paid for the same Groq call twice out of one
8,000-token minute; it now takes an atomic `mkdir` lock with a 90-minute staleness escape
hatch, because a crashed run that permanently and silently disables the pipeline is this
project's characteristic failure. And the two lanes write separate logs — twenty-four "nothing
new" entries a day would bury the one entry anybody reads.

**`--status` had started lying** and was fixed in the same change: it reported the interval job
as "next run 00:00" and pointed at `daily.log`. A status command that is confidently wrong is
worse than no status command.

---

## 037 — Bounce and reply tracking, and the honest answer about spam

**Decision.** `src/track/replies.ts` reads the mailbox on the hourly lane and resolves every
sent message into one of four outcomes: **replied**, **bounced (unknown mailbox)**, **bounced
(blocked)**, or **deferred**. It ships *before* the first send, not after.

**Why it is a prerequisite.** Three different failures produce the identical observation —
silence — and they need three unrelated fixes:

| What happened | Evidence | What to fix |
|---|---|---|
| the address does not exist | `550 5.1.1`, an NDR | the contact cascade |
| we were refused as spam | `550 5.7.1`, "blocked" | reputation, content, volume |
| it arrived and nobody cared | nothing at all | the email, the hook, the targeting |

Sending without this means spending opportunities and learning nothing from them.

**Spam-foldering cannot be detected from the sender side, and this is the honest answer to
"how do I know my mail is not going to spam".** When a provider files a message as spam the
SMTP transaction has already succeeded — 250 OK, no bounce, no notification, nothing comes
back. What *is* observable is a **rejection**, where the receiving server refuses the message
and says why, and that is the entire reason `bounce_reason` exists (migration 006). Lumping it
in with a wrong address would average away the only spam signal available.

A `blocked` bounce is therefore raised through `ctx.fault` rather than logged: a wrong address
is one job's problem, but being refused on policy grounds affects every future send, and the
health check is what surfaces that the same morning (decision 026).

**Three things deliberately not done:**

- **No tracking pixel.** The standard answer, and wrong here — an image in a plain-text email
  is itself a bulk-mail signal, and Gmail's image proxy and Apple Mail Privacy Protection open
  it whether or not a human did. It would raise spam risk in order to measure spam risk.
- **No Google Postmaster Tools.** It requires ownership of the sending domain; he sends from
  `gmail.com`.
- **No follow-up scheduling yet.** Day-4 follow-ups are still an open question for him, and
  detection is useful on its own.

**Seed addresses are the one technique that does work**, so `OutgoingDraft.bcc` exists to
support it: copy addresses he controls at the providers that matter — his eight drafts split
three Microsoft 365, three Google Workspace — and look at which folder the copy lands in. A
BCC is invisible to the recipient and carries the byte-identical message, which no separately
composed test email does.

**A 4.x.x deferral is not a bounce.** It is the receiving server asking us to come back, and
`BOUNCED` is terminal. It is recorded in `bounce_reason` so a run of them is visible, and the
row stays in `SENT` awaiting a real answer.

**It rides the hourly lane rather than taking a third agent.** `architecture.md` specified
four-hourly; hourly costs two Gmail searches, notices a reply three hours sooner, and a reply
is the one event in this system worth being prompt about. One mailbox pass serves every
pending row — at eight sends a day the inbox is small and `messages.get` costs five quota
units apiece.

**Bounces are matched by the recipient address in the body, not by thread.** Gmail does not
reliably thread a non-delivery report with the message that caused it; a report from the far
side arrives as its own conversation.

---

## 038 — One live conversation per company, and the ramp starts at the first send

**Decision.** Utkarsh's calls, 2026-08-29:

- **A second role at a company already being written to is skipped, not queued.**
- **The ramp stands: 3/day week one, 5 week two, 8 week three.**

Both are implemented in `src/send/gate.ts` and enforced by the **draft** stage today, ahead of
the sending machinery that will also use them.

**Why suppression is not a job state.** It is a fact about *now*, and it lifts by itself: if
that first email bounced it never arrived, so the company was never really contacted and the
sibling role becomes eligible again. A state would make it permanent and would need an edge
out of a terminal state to undo. So it is a predicate at selection time —
`SUPPRESSED_BY_SIBLING` — and there is a test that a bounce lifts it.

**The role that survives is the better one**, because drafting is ordered by score. Suppression
picks nothing; it only stops the second.

**The within-a-run case was a real gap, caught by a test that had been asserting the opposite.**
`two roles at one company each get their own draft to the same contact` was a correct test of
the old behaviour and became a statement of the bug. The SQL predicate only sees `outreach`
rows that already exist, so in a single morning both roles survive selection — the loop now
tracks which companies it has written to. Currently 5 companies have two drafted-ready roles
each (SkilloVilla, Unisys, Vinculum, Stripe, Canonical), so this was not hypothetical.

**Drafting is capped by the ramp, not by the reading limit.** `MAX_DRAFTS_PER_RUN` was a flat
8, which under a 3/day cap would queue five drafts a morning that cannot be sent — a Drafts
folder he has to scroll past, which is exactly what decision 035 refused to build. `dailyCap()`
is now the real limit and 8 is only the backstop at the top of the ramp. First dry run under
the policy drafted **3**, all on published addresses, no siblings.

**Week one begins at the first send, not at a date in a constant.** `dailyCap()` derives the
week from `MIN(outreach.sent_at)`, so editing a config file cannot fast-forward the ramp, and
a pipeline that has never sent is always at the start.

**Still open:** follow-ups — one at day four, or none in v1. The tracker detects replies and
bounces already (037); nothing schedules a second email, and nothing will until that is
decided.
