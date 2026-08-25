# jobagent, explained

A plain-English guide to what this project is, why it exists, and what every file in it does.
No programming knowledge assumed. Everything else in `docs/` is written for whoever is
building the thing; **this file is written for Utkarsh.**

Last updated 2026-08-24.

---

## The one-paragraph version

Every morning at 6am, a program on this laptop wakes up, collects new software-engineering
internships from job boards and from job-alert emails, reads each one against Utkarsh's
resume, decides which are actually worth applying to, and sends the best ones to his phone on
Telegram. As of 25 August it also finds the company's real website, digs out an email address
worth writing to, and **writes the cold email itself — saved as a draft in your Gmail, never
sent.** What it cannot do, by design, is send anything: that needs your approval and is the
next phase.

## Why it exists

Looking for internships is a grind of repetitive work: the same searches on the same sites,
every day, mostly finding the same postings you saw yesterday. The useful part — noticing the
handful of genuinely good matches and writing to a human about them — takes ten minutes. The
other two hours are searching.

So this automates the searching and the filtering, and leaves the judgement to a person.
The design assumption throughout is that **it is worse to send a bad email than to miss a good
job**, which is why nothing sends itself without either a high confidence score or explicit
approval.

## How a morning actually works

```
06:00   the laptop wakes the program up
        ↓
        wait for the internet to actually work        (this took three tries to get right)
        ↓
  1.  COLLECT   read job-alert emails, then poll 51 company job boards
        ↓
  2.  SCORE     ask an AI to rate each new job against the resume, on four things
        ↓
  3.  DECIDE    do the arithmetic; good enough → keep it, not → reject it forever
        ↓
  4.  FIND      work out the company's real website, then an address worth writing to
        ↓
  5.  WRITE     draft the email and save it in Gmail — nothing is sent
        ↓
  6.  REPORT    send the best 10 to Telegram, with the drafts to review
        ↓
        if anything broke, say so — once
```

Only the last step, sending, is still a placeholder. It runs, does nothing, and logs that it is
not built yet.

### Why nothing sends yet, on purpose

The program can write into your Gmail but it physically cannot send. There is one function for
sending and it does not exist yet. Everything it writes lands in your Drafts folder, where you
read it, change it, or delete it. **A cold email to a stranger is not reversible**, so a human
sees every one before it goes — and when sending is built, it will still only send by itself
when the address was published on the company's own site *and* the job scored above 85.
Everything else waits for you to tap approve.

### Where the jobs come from

Two very different places, and the difference matters a lot:

**Company job boards** (51 of them). Companies like Stripe and Cloudflare publish their
openings in a machine-readable format. We read those directly. These postings come with a full
job description, so there is a lot to judge them on. But **102 of the 153 Indian companies on
the wish list have no such board at all** — Zomato, Swiggy, Flipkart, Zerodha, Razorpay all
run their own private systems. So this source is mostly global and remote companies.

**Job-alert emails.** LinkedIn and Naukri email Utkarsh when something matches his saved
searches, and those emails get forwarded into a mailbox this program can read. This is where
Indian coverage comes from, and it is now the *main* source: 83 of the 90 jobs in the database
arrived this way.

Nothing is scraped. LinkedIn and Naukri are read only through **Utkarsh's own email**, never by
pretending to be a browser on their websites. That is the difference between a tool and a
banned account.

The catch: an alert email contains a job *title*, a company and a city — and no description.
So the scorer has far less to work with, and that single fact has driven more design decisions
than anything else in the project.

### How a job gets scored

The AI is never asked "how good is this job, out of 100". That was tried, and the same posting
came back 55, then 78, then 90, then 92 — and because rejection is permanent, a bad roll would
silently throw away a good job forever.

Instead it is asked four narrow questions, each rated 0–10:

| Question | What it means |
|---|---|
| **level_fit** | Can a final-year student actually take this job? |
| **location_fit** | Can it be done from India? |
| **stack_fit** | Does it use technology Utkarsh has actually built with? |
| **domain_fit** | Are the problems ones he has actually solved? |

Then **the program does the arithmetic**, not the AI. Level and location count for most,
because they are the two things that make a job flatly impossible rather than merely a stretch.
If either is near zero, the whole score is capped low — no amount of "but the technology
matches" can rescue a job in another country.

If a posting has no description, the total is docked 15% and capped at 84. That number is
deliberate: sending an email by itself requires above 85, so **a posting nobody has actually
read can never mail itself.**

70 out of 100 is the cut-off. It rejects things like "Signal Processing Intern" and "Flutter
Developer Intern" — real jobs, wrong person — and keeps things like Sony Research India's AI
Research Intern.

---

## What we have built, in order

**Phase 0 — the skeleton.** A database, a strict definition of every kind of record, and a
runner that executes the steps in order. Nothing useful yet, but nothing built on sand.

**Phase 1 — a useful daily digest.** ✅ Finished 2026-08-14, when the first digest arrived on
the phone with nobody typing anything.

That date is misleading, though, and the honest version is more interesting: the code worked
for a week *before* the thing actually worked. Five separate failures, each of which looked
exactly like success:

| What broke | How long before we noticed |
|---|---|
| The laptop's Wi-Fi wasn't awake at 6am, so nothing was found | 2 days |
| One slow website held the whole run open for 7 hours | 4 days |
| The digest failed to send and never retried | 4 days |
| Google's login expired, cutting off the main source of jobs | 4 days |
| Every emailed job scored the identical number, so the filter did nothing | 2 weeks |

Every one of those finished with a "success" code. Every one was recorded properly in the
database. Nobody looked, because nothing asked anyone to look. **That is why the program can
now message you when it breaks** — once per problem, never a daily "all fine" that you would
learn to ignore.

**Phase 2 — contacts and drafts.** ✅ Built 2026-08-25. Eight real drafts are in your Gmail
right now. It is not *finished* until you read them and say whether you would send them.

It turned out to be about something nobody planned for. **73 of the 78 matched jobs had no
company website attached** — they came from LinkedIn and Naukri alert emails, and those emails
link to LinkedIn and Naukri, never to the company. Every way of finding an email address starts
from a website, so before anything else could work, the program had to turn a name like
"Berryworks Kochi Adoor" into a real domain.

The rule it follows is worth knowing, because it is what keeps you out of trouble: **guessing a
website is fine, believing the guess is not.** Every guess has to pass two tests — the domain
must be set up to receive email at all, and its actual home page must say the company's name.
Out of 69 companies it got 59 right, and the two tests caught real mistakes: two of the guessed
domains were for-sale parking pages, and three others were ordinary English words belonging to
somebody else (a tea shop called Chai, a sock company called Stance).

Where it cannot prove a website, it says so and writes nothing. Eleven jobs are in that state.

**Phase 3 — sending.** Not started, and deliberately not started yet: it automates sending
whatever Phase 2 writes, so if the drafts are wrong it would automate being wrong. Read the
eight first. After that it is approval buttons in Telegram, a daily cap, a slow ramp-up from
three a day, and watching for replies.

### Where it stands today

- **91 jobs** scored, 67 ready to write to, 11 waiting on a website, 17 rejected
- **64 of 83 companies** now have a proven website, up from 5
- **62 contacts**: 28 published on a real page, 34 educated guesses at `careers@`
- **8 drafts written into Gmail.** None sent. Nothing can send yet
- **265 tests**, all passing. **30 written decisions** explaining why things are as they are
- **Total cost: ₹0.** Everything runs on free tiers

**The whole morning now takes about three and a half minutes.**

---

## What every file does

### The daily runner

| File | In plain terms |
|---|---|
| `src/main.ts` | The conductor. Runs each step in order, gives each one a time limit, and records what happened. If one step fails, the rest still run. |
| `src/stage.ts` | Defines what each step is handed when it runs — the database, a way to log, a way to report a problem. |
| `scripts/run-daily.sh` | What the 6am alarm actually executes. Waits for the internet, then starts the runner, and writes everything to a log file. |
| `src/schedule/launchd.ts` | Sets up (and removes) the 6am alarm itself. macOS calls these "launch agents". |

### Storing things

| File | In plain terms |
|---|---|
| `src/store/schema.ts` | The single definition of every kind of record — what a job looks like, what a score looks like. Everything else checks against this. |
| `src/store/db.ts` | Opens the database file and keeps its structure up to date. |
| `src/store/state.ts` | The rulebook for a job's life: discovered → scored → matched → drafted → sent. **The only place a job's status can change**, so illegal jumps are impossible rather than merely discouraged. |
| `src/store/jobs.ts` | Saving and finding jobs, including working out when two listings are the same job seen twice. |
| `src/store/companies.ts` | Same, for companies. One row per real company, however many times it shows up. |
| `src/store/scores.ts` | Saving scores. Old scores are never overwritten, so changing the scoring rules doesn't destroy the history. |
| `src/store/digest.ts` | Works out which jobs deserve to be in tomorrow's message, and in what order. |
| `src/store/migrations/*.sql` | The database's structure, in the order it was built up. Four so far. |

### Finding jobs

| File | In plain terms |
|---|---|
| `src/ingest/index.ts` | Runs every source in turn, best one first, and stops any single source hogging the time. |
| `src/ingest/types.ts` | The shape every job source must fit. Adding a new source = one new file, nothing else changes. |
| `src/ingest/ats.ts` | Reads the four kinds of company job board (Greenhouse, Lever, Ashby, Workable). |
| `src/ingest/candidates.ts` | The wish list of companies to look for. Nothing here is trusted until checked. |
| `src/ingest/refresh-companies.ts` | Checks that wish list against the real websites, and writes down only the ones that genuinely answer. About half of any guessed list is wrong. |
| `src/ingest/companies.ts` | Loads that verified list. |
| `src/ingest/gmail-alerts.ts` | Treats job-alert emails as a source of jobs. Emails from a sender we can't read yet get counted, so we notice when a new kind arrives. |
| `src/ingest/naukri-alert.ts` | Reads a Naukri alert email. Pulls details out of the *link* rather than the visible text, because the visible text cuts company names off. |
| `src/ingest/linkedin-alert.ts` | Reads a LinkedIn alert email. Finds the job title in the formatted version, then reads the company and city beneath it in the plain-text version. |
| `src/ingest/resolve-company.ts` | Turns a company *name* into a web address. If it can't, it says so explicitly rather than guessing — a wrong address could mean emailing a stranger. |
| `src/ingest/filter.ts` | Cheap early filters: is this an early-career technical role, is it in India, does it say "unpaid". Deliberately generous — the scorer is the judge. |
| `src/ingest/http.ts` | Fetches web pages safely: time limits, retries, and knowing the difference between "this company has no board" and "the internet is down". |
| `src/ingest/html.ts` | Turns web formatting into readable plain text. |

### Judging jobs

| File | In plain terms |
|---|---|
| `src/match/score.ts` | The scoring step. Asks the AI its four questions, does the arithmetic, decides keep-or-reject, and writes the result. The largest file in the project. |
| `src/match/profile.ts` | Read the resume PDF once and turn it into structured facts everything else uses. |
| `src/llm/groq.ts` | Talks to the AI service. Handles the AI occasionally returning malformed answers by simply asking again. |
| `src/llm/models.ts` | Which AI model does which job. The names are checked against the live service, never remembered. |
| `src/llm/rate-limit.ts` | The free AI plan allows about two requests a minute. This waits for room rather than being refused — which is why scoring takes about 67 seconds per job. |

### Finding someone to write to

| File | In plain terms |
|---|---|
| `src/contacts/domain.ts` | Turns a company *name* into its real website, and proves it before believing it. Tries the obvious guesses first (free, instant), asks the AI only for the ones that fail, and tests every answer the same way. |
| `src/contacts/verify.ts` | Asks the internet whether a domain can receive email at all. Cheap, and it caught two for-sale parking pages pretending to be companies. |
| `src/contacts/cascade.ts` | Looks for an address in four places, best first: the job posting, the company's own website, its GitHub page, and finally an educated guess at `careers@`. Refuses addresses at the wrong desk — `sales@`, `support@`, and anything that belongs to a different company. |
| `src/contacts/index.ts` | The find-a-contact step. Does the work once per company however many jobs are open there, and gives up on a company after three tries across nine days. |

### Writing the email

| File | In plain terms |
|---|---|
| `src/draft/compose.ts` | Writes the email. Then *checks its own output* and rewrites it once if it finds a problem — a leftover `[Your Name]`, an unsigned email, or a claim the resume does not support. It once wrote "as a final-year student", which your resume never says; that check exists because of it. |
| `src/draft/gmail-draft.ts` | Puts the finished email into Gmail as a draft. This is the only part of the program that can write to your account, and it has no ability to send. |
| `src/draft/index.ts` | The writing step. Eight a morning, best-scoring first, and one email per job ever. |

### Talking to Utkarsh

| File | In plain terms |
|---|---|
| `src/notify/digest.ts` | Builds and sends the morning message. A job appears exactly once, ever — and from now on it also lists the drafts waiting in Gmail, marking clearly which addresses were guessed. |
| `src/notify/telegram.ts` | Sends Telegram messages, retrying if the network wobbles. |
| `src/notify/health.ts` | Messages when something is newly broken, and stays silent otherwise. A problem that lasts a fortnight costs one message, not fourteen. |

### Email access

| File | In plain terms |
|---|---|
| `src/gmail/auth.ts` | The one-time "let this program read my mail" permission dance with Google. |
| `src/gmail/messages.ts` | Searching the mailbox and pulling messages apart. Also a command-line tool for looking at real emails, which is how both alert readers were written. |

---

## The rules that must never be broken

These are in `CLAUDE.md` too, because breaking one causes real-world damage:

1. **Never send email directly.** Always create a draft first, then send that draft. One path
   for everything, so there is always a record of what went out.
2. **One email per job, structurally.** The database physically cannot store two.
3. **A guessed email address never sends itself.** Only addresses found on the actual posting
   or a company's own team page are eligible.
4. **Running twice must change nothing.** Every step can be safely re-run.
5. **Respect the daily cap and the slow ramp-up.** 3 a day, then 5, then 8. Never start at 8.
6. **Nothing is remembered in memory between steps.** A crash halfway through is fixed by
   running it again.

## What it costs

Nothing. The AI runs on Groq's free plan, Gmail and Telegram are free, and the database is a
single file on the laptop. The one deliberate escape hatch, if the emails turn out to need
better writing, is about $3.75 a month for a stronger model — one file would change.

## What to do next

**Read the eight drafts in your Gmail Drafts folder.** That is the whole test of this phase.
For each one, the useful question is not "is it good" but *would you send this* — and if not,
which part is wrong:

- the **opening fact** about you is the wrong one → that comes from the scoring step
- the **address** is the wrong person → that comes from the contact search
- the **tone** is off → that is the email-writing instructions, one file

Those are three different fixes in three different places, and guessing which is why eight were
written rather than one.

One thing you will notice: six of the eight lead with the same typeahead project, because the
scorer picked the same fact for most jobs. No recruiter sees more than one of them, so it does
no harm — but if you want more variety, that is a scoring change, not a writing one.

## When something looks wrong

```
cd ~/jobagent
node src/schedule/launchd.ts --status    # did this morning's run happen? did it work?
tail -40 logs/daily.log                  # what actually happened

node src/draft/index.ts --job=12         # see what it would write about one job
node src/contacts/domain.ts --name="Convin"   # see how it works out a company's website
```

The two most common problems, both seen repeatedly:

- **"invalid_grant"** — Google's permission expired. Fix: `node src/gmail/auth.ts`. It keeps
  happening because the app's consent screen is still in "Testing" mode, which expires the
  permission every 7 days. Publishing it stops that.
- **A run that finishes suspiciously fast with nothing found** — usually the laptop's internet
  wasn't up yet. The program now waits up to 15 minutes and skips the day cleanly if it never
  arrives.

## The other documents

| File | What it is |
|---|---|
| `CLAUDE.md` | The short briefing an AI assistant reads at the start of every session. |
| `docs/architecture.md` | How the pieces fit together, technically. |
| `docs/phases.md` | The plan, and what is done. |
| `docs/decisions.md` | **The most valuable one.** 27 entries explaining why each choice was made, usually with the measurement that forced it. Written so nobody re-makes a mistake that was already paid for. |
| `docs/agenthandoff.md` | What was happening when the last work session ended. |
