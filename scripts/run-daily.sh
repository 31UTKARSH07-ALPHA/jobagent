#!/bin/sh
#
# What launchd runs at 06:00. Run it by hand and you reproduce that run exactly —
# same cwd, same node, same flags, same log. "Works when I run it, fails on the
# schedule" is the failure this file is designed to make impossible.
#
#   ./scripts/run-daily.sh              full pipeline
#   ./scripts/run-daily.sh --dry-run    everything except sending
#
# launchd starts jobs with a near-empty environment: no PATH to speak of, cwd `/`,
# and none of a login shell's setup. So nothing here may assume a shell profile.
# `node --env-file-if-exists=.env` resolves .env against the *cwd*, which is why
# the cd below is load-bearing and not tidiness.
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
cd "$ROOT" || exit 1

# The plist records an absolute node path (launchd has no usable PATH). By hand,
# whatever node is on PATH is the right answer.
NODE=${JOBAGENT_NODE:-$(command -v node || true)}
if [ ! -x "$NODE" ]; then
  echo "run-daily: no node executable (JOBAGENT_NODE=${JOBAGENT_NODE:-unset}, PATH=$PATH)" >&2
  exit 127
fi

LOG_DIR=$ROOT/logs
LOG=$LOG_DIR/daily.log
MAX_BYTES=5242880 # 5 MB, ~2 months of runs
mkdir -p "$LOG_DIR" || exit 1

# Rotate before the log is opened, never while: launchd would otherwise keep writing
# into the renamed file through a file descriptor that no longer matches the name.
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt "$MAX_BYTES" ]; then
  mv -f "$LOG" "$LOG.1"
fi

stamp() { date "+%Y-%m-%dT%H:%M:%S%z"; }

# ── Wait for the network ─────────────────────────────────────────────────────
#
# launchd runs a missed 06:00 job when the laptop *wakes*, and Wi-Fi associates a
# minute or two after that. Measured 2026-08-14 and 08-15: both runs started ~06:12,
# DNS was still dead ("getaddrinfo ENOTFOUND oauth2.googleapis.com"), all 51 boards
# failed, and the run spent **55 minutes** timing out its way to zero jobs.
#
# Every stage needs the network, so there is nothing useful to do without it. Wait,
# then run; or give up cleanly and let tomorrow retry rather than write a run of
# failures into the DB.
# The hosts without which this run has nothing to do. One is not enough: measured on
# 2026-08-21 to 08-23, oauth2.googleapis.com resolved in 10 seconds while api.lever.co and
# api.telegram.org were still hanging — DNS came back for some names and not others, so a
# single-host check waved the run through into 17-minute lookups.
#
# Board hosts are deliberately NOT here. A dead ATS is normal and costs one source; these
# three each cost a whole stage: Groq is scoring, Google is the alert email that carries most
# of the postings, Telegram is the digest itself.
NET_HOSTS=${JOBAGENT_NET_CHECK:-"https://api.telegram.org/ https://api.groq.com/ https://oauth2.googleapis.com/"}
NET_WAIT_SECONDS=${JOBAGENT_NET_WAIT:-900} # 15 min
NET_POLL_SECONDS=10

# curl exits 0 when DNS, TCP and TLS all worked, whatever HTTP status comes back. Its own
# --max-time covers the DNS lookup, which is exactly what node's AbortSignal does not.
CURL=$(command -v curl || true)

unreachable() {
  for host in $NET_HOSTS; do
    "$CURL" -sS --max-time 5 --head "$host" >/dev/null 2>&1 || { echo "$host"; return 0; }
  done
  return 1
}

wait_for_network() {
  # Fail *open*. A missing curl must not turn into a run that is skipped every morning
  # for a reason nobody can see — the pipeline survives a dead network by itself, it is
  # only slow about it.
  if [ ! -x "$CURL" ]; then
    echo "   no curl on PATH — skipping the network check, not the run"
    return 0
  fi

  blocked=$(unreachable) || return 0

  echo "   waiting for the network, up to ${NET_WAIT_SECONDS}s — $blocked not reachable yet"
  waited=0
  while [ "$waited" -lt "$NET_WAIT_SECONDS" ]; do
    sleep "$NET_POLL_SECONDS"
    waited=$((waited + NET_POLL_SECONDS))
    blocked=$(unreachable) || {
      echo "   all of $NET_HOSTS reachable after ${waited}s"
      return 0
    }
  done
  echo "   still cannot reach $blocked"
  return 1
}

# The status file exists because the pipeline's exit code is on the far side of a
# pipe, and `$?` after a pipeline is tee's.
status_file=$(mktemp -t jobagent-status) || exit 1
trap 'rm -f "$status_file"' EXIT INT TERM

{
  echo "── $(stamp)  start  ${*:-full pipeline}"
  if wait_for_network; then
    "$NODE" --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/main.ts "$@"
    echo $? >"$status_file"
  else
    # 75 is EX_TEMPFAIL: nothing is broken, the conditions were wrong. It shows up in
    # `launchd.ts --status` as a distinct number, which is the point — a silent
    # zero-job run and a skipped run must not look the same afterwards.
    echo "   no network after ${NET_WAIT_SECONDS}s — skipping the run entirely"
    echo 75 >"$status_file"
  fi
  echo "── $(stamp)  exit $(cat "$status_file")"
} 2>&1 | tee -a "$LOG"

# Under launchd, tee's stdout goes to /dev/null and this log is the only copy;
# by hand it also reaches the terminal.
exit "$(cat "$status_file" 2>/dev/null || echo 1)"
