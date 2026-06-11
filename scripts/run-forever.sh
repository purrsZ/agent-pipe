#!/usr/bin/env bash
# Supervisor loop: keep the bot alive across crashes.
#   - exit 0  → intentional stop (SIGINT/SIGTERM or clean shutdown), do NOT restart
#   - exit ≠0 → crash, restart with backoff (3s doubling up to 60s; reset after a
#               stable run of ≥60s so a healthy bot always restarts fast)
# Usage:
#   ./scripts/run-forever.sh                  # logs to /tmp/agent-pipe.run.log
#   AGENT_PIPE_LOG=/path/to.log ./scripts/run-forever.sh
set -u
cd "$(dirname "$0")/.."

LOG_FILE="${AGENT_PIPE_LOG:-/tmp/agent-pipe.run.log}"
TSX="node_modules/.bin/tsx"

log() { echo "[run-forever] $(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG_FILE"; }

child=0
stopping=0
on_stop() {
  stopping=1
  if [ "$child" -ne 0 ]; then
    kill -TERM "$child" 2>/dev/null || true
  fi
}
trap on_stop INT TERM

backoff=3
log "supervisor started (pid $$), log: $LOG_FILE"
while true; do
  log "starting bot"
  "$TSX" src/index.ts >>"$LOG_FILE" 2>&1 &
  child=$!
  start_ts=$(date +%s)
  wait "$child"
  code=$?
  child=0
  if [ "$stopping" -eq 1 ] || [ "$code" -eq 0 ]; then
    log "bot stopped (exit $code), supervisor exiting"
    exit 0
  fi
  ran=$(( $(date +%s) - start_ts ))
  if [ "$ran" -ge 60 ]; then
    backoff=3
  else
    backoff=$(( backoff * 2 ))
    [ "$backoff" -gt 60 ] && backoff=60
  fi
  log "bot crashed (exit $code) after ${ran}s — restarting in ${backoff}s"
  sleep "$backoff" &
  wait $!
  if [ "$stopping" -eq 1 ]; then
    log "stop requested during backoff, supervisor exiting"
    exit 0
  fi
done
