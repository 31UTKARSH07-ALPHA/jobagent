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
