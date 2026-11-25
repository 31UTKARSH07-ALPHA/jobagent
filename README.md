# JobAgent

JobAgent is a personal workspace for collecting internship and job alerts, reviewing outreach, tracking follow-ups, and preparing for interviews. It does not submit job applications for you. Email sending stays disarmed unless deliberately configured on your local installation.

## Run locally

Use Node.js 25 or later:

```sh
npm ci
npm run dashboard
```

Open the workspace at <http://127.0.0.1:4317/> or view the product landing page at <http://127.0.0.1:4317/landing>. See [dashboard usage and limitations](docs/dashboard.md). The local mode trusts loopback access; do not expose it through a tunnel or reverse proxy.

For optional resume extraction, copy `profile-corrections.example.json` to the ignored `profile-corrections.json` and fill in any verified corrections. Keep your PDF and extracted profile out of Git.

## Host a private workspace

The Dockerfile packages the application without your local SQLite database, Gmail tokens, resume profile, or `.env`. Use a Node container host with persistent disk and HTTPS. Mount an empty writable volume at `/state` and configure these secrets and values on the host:

| Variable | Purpose |
| --- | --- |
| `JOBAGENT_DASHBOARD_ORIGIN` | Exact public HTTPS origin, with no path |
| `JOBAGENT_DASHBOARD_SETUP_TOKEN` | Secret of at least 32 characters used only to create the first owner account |
| `JOBAGENT_DASHBOARD_MODE` | `hosted` (already set in the Dockerfile) |
| `JOBAGENT_DB` | Absolute database path on the writable volume; defaults to `/state/jobagent.db` in the container |

Route HTTPS to the dashboard's container port 8080 and preserve the public `Host` header. Use `/signup` for initial owner setup, then `/login` for subsequent visits. Do not expose the container port directly without TLS. This is an owner-only workspace, not open registration. A fresh hosted install will be empty. The laptop's job schedules, Gmail integration, and local model are not automatically deployed with the dashboard.

## Verify

```sh
npm run typecheck
npm test
```
