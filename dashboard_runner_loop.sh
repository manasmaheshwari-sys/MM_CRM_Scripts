#!/usr/bin/env bash
# Long-lived runner loop for the GitHub Actions workflow.
#
# GitHub's cron drops or delays most scheduled ticks, so instead of starting a
# fresh job per slot, ONE job stays alive for ~5h20m and does the slot timing
# itself: every SLEEP_SECONDS it asks should_run_refresh.js whether a refresh is
# due (latest 11/13/15/17/18/19 IST slot started, <= 90 min old, dashboard's own
# "Last updated" stamp older than it) and runs the pipeline if so. When the loop
# window ends the workflow dispatches its own successor, so the chain continues
# all day and night; a slow cron "safety net" restarts it if it ever breaks.
#
# Env overrides (used for local testing):
#   LOOP_MAX_SECONDS  how long to loop before handing over   (default 19200 = 5h20m)
#   SLEEP_SECONDS     pause between checks                    (default 120)
#   COOLDOWN_SECONDS  min gap between pipeline attempts       (default 1200) — stops a
#                     failing run (or the gate failing open) from hammering Firestore
#   PIPELINE_CMD      command to run when a refresh is due    (default node run_daily_report.js)
set -uo pipefail

LOOP_MAX_SECONDS="${LOOP_MAX_SECONDS:-19200}"
SLEEP_SECONDS="${SLEEP_SECONDS:-120}"
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-1200}"
PIPELINE_CMD="${PIPELINE_CMD:-node run_daily_report.js}"

stamp() { TZ=Asia/Kolkata date '+%d %b %H:%M IST'; }

START=$(date +%s)
LAST_ATTEMPT=0
LAST_SKIP_LOG=0
echo "[$(stamp)] runner loop started (window ${LOOP_MAX_SECONDS}s, check every ${SLEEP_SECONDS}s)"

while :; do
  NOW=$(date +%s)
  if [ $((NOW - START)) -ge "$LOOP_MAX_SECONDS" ]; then break; fi

  DECISION=$(node should_run_refresh.js 2>&1 | grep -E '^(RUN|SKIP):' | tail -1)

  if [[ "$DECISION" == RUN:* ]]; then
    if [ $((NOW - LAST_ATTEMPT)) -ge "$COOLDOWN_SECONDS" ]; then
      echo "[$(stamp)] $DECISION -> running pipeline"
      LAST_ATTEMPT=$(date +%s)
      $PIPELINE_CMD
      RC=$?
      if [ "$RC" -eq 0 ]; then
        echo "[$(stamp)] pipeline finished OK"
      else
        echo "[$(stamp)] pipeline FAILED (exit $RC) - will retry after the cooldown if still due"
      fi
    fi
  elif [ $((NOW - LAST_SKIP_LOG)) -ge 1800 ]; then
    echo "[$(stamp)] $DECISION"
    LAST_SKIP_LOG=$NOW
  fi

  sleep "$SLEEP_SECONDS"
done

echo "[$(stamp)] loop window finished - handing over to the next run"
