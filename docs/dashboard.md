# JobAgent Dashboard

From the project root, run `npm run dashboard` and open <http://127.0.0.1:4317>.
The server listens only on this Mac. Do not expose it over a tunnel or reverse proxy:
its API reads private email drafts from the same SQLite database as the scheduled agent.
`JOBAGENT_DASHBOARD_PORT` overrides the default port. Restart the dashboard if you
change its `.env` settings.

- **Job alerts** shows postings first seen in the last 30 days. Search by role, company,
  or location, or filter to matches. Apply opens the original posting; it does not apply
  on your behalf.
- **Drafts** shows only unsent, active outreach with a recorded Gmail draft, newest first.
  Send asks for confirmation and records approval for the existing scheduled sender;
  it never calls Gmail itself. Sending remains unavailable while `JOBAGENT_SEND` is
  disarmed. The sender's schedule and daily send cap still apply.
- **Learning** suggests review topics, a short project, and mock questions based on
  the selected role's title. It does not call an AI service or claim these are employer questions.

Refresh reloads the database view, not the upstream job feeds. The dashboard does not
change your saved resume profile or rescore older jobs.

**Delete** permanently removes the selected unsent draft from Gmail after confirmation
and keeps the original job posting. Queued or sent messages are protected. If Gmail
does not confirm deletion, the draft is blocked from sending and the UI offers a retry.

**Replies** reads incoming messages in Gmail threads linked to sent outreach. It shows
company, sender, received date, a text preview, and a link to the original thread. It
does not scan for unrelated or newly started threads. Reads are cached for up to a minute.

The outreach workspace distinguishes Needs Review, Approved (queued), Sent, and Archived.
Archiving is reversible and leaves the Gmail copy untouched. Local edits preserve the original
Gmail-backed message. The edited working copy can be previewed and copied but cannot be queued
through either dashboard or Telegram. Manual actions in Gmail are outside the dashboard's control.
Local regeneration proposes a role-specific template; accepting it only loads it into the editor.
Quality checks are advisory and run locally against the saved profile, job, and contact. They do
not send content to an external model or verify that a recipient's mailbox exists.

Application records are optional, one per tracked job. Creating or linking one does not submit
an application or claim that it was submitted. Follow-up dates are manual reminders; no email
is scheduled by setting one. The timeline uses the actual outreach timestamps already recorded.

### Follow-ups, outcomes, and analytics

The Outreach tab retains the old `#drafts` link as an alias. The Follow-ups tab tracks
notes, snoozes, reschedules, and completions. Dates are interpreted on the dashboard host.
An unsent message needs explicit approval to create a reminder. These are visual reminders,
not scheduled notifications. Old reminder dates are imported without inventing a history.
The tracking field on an outreach message is a shortcut for adding a follow-up; use
Follow-ups to manage the resulting record.

Manual outcomes do not change send or reply timestamps. Analytics deduplicates manual
and recorded responses per sent message and separates confirmed events from legacy records.
Positive and interview counts reflect current manual outcomes, not inferred sentiment.

The optional **AI review (local)** button uses Ollama on loopback only. Run Ollama in
local-only mode (`OLLAMA_NO_CLOUD=1 ollama serve`) and set `JOBAGENT_OLLAMA_MODEL`
to an already installed local model. Restart the dashboard after setting it. Regular
**Check quality** works without Ollama. AI suggestions are advisory; acceptance changes
only the editor until you explicitly save the local working copy.

### Interview preparation

Click **Prep** beside a posting. The brief ranks practice topics by signals in the saved
job description and title, and shows why each topic was selected. Title-only postings are
labeled as estimates. The brief does not claim to know a company's actual interview questions.
There is no role menu, application creation, or model call. Older plans remain in SQLite.
