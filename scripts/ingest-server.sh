#!/bin/bash
#
# Launcher for the ingest server, run by launchd at login.
#
# It exists rather than pointing the LaunchAgent straight at the venv binary for
# one reason: Postgres is a separate LaunchAgent and launchd gives no ordering
# guarantee between the two. This waits for the database before starting.
#
# See ~/Library/LaunchAgents/com.ecomscraper.ingest.plist.

set -euo pipefail

ROOT="/Users/calvin/ecom-scraper"
cd "$ROOT"

# 0700, because the server prints the ingest token on startup and launchd sends
# that to logs/ingest.log. The token is a write credential for the database, so
# the directory gets the same treatment as .ingest-token itself.
mkdir -p logs
chmod 700 logs

# Wait for Postgres, but do not require it.
#
# The server itself opens no connection at startup — SQLAlchemy engines are
# lazy, so it will boot fine and only fail per-request while the database is
# down. Starting anyway after the timeout therefore beats exiting: a running
# server that returns errors is visible in the logs and answers /health, while
# an exited one just crash-loops under KeepAlive with nothing to inspect.
deadline=$((SECONDS + 60))
until pg_isready -h 127.0.0.1 -p 5432 -q; do
    if [ "$SECONDS" -ge "$deadline" ]; then
        echo "[$(date -Iseconds)] Postgres not ready after 60s; starting anyway." >&2
        break
    fi
    sleep 2
done

# exec, so launchd supervises uvicorn itself rather than this shell. Without it
# KeepAlive would watch the wrapper and a dead server could go unnoticed.
echo "[$(date -Iseconds)] starting ingest server on 127.0.0.1:8787"
exec "$ROOT/.venv/bin/ecom-scraper" serve --host 127.0.0.1 --port 8787
