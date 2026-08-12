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

# The status file exists because the pipeline's exit code is on the far side of a
# pipe, and `$?` after a pipeline is tee's.
status_file=$(mktemp -t jobagent-status) || exit 1
trap 'rm -f "$status_file"' EXIT INT TERM

{
  echo "── $(stamp)  start  ${*:-full pipeline}"
  "$NODE" --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/main.ts "$@"
  echo $? >"$status_file"
  echo "── $(stamp)  exit $(cat "$status_file")"
} 2>&1 | tee -a "$LOG"

# Under launchd, tee's stdout goes to /dev/null and this log is the only copy;
# by hand it also reaches the terminal.
exit "$(cat "$status_file" 2>/dev/null || echo 1)"
