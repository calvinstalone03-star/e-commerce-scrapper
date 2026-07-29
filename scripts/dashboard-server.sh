#!/bin/bash
#
# Launcher for the Next.js dashboard, run by launchd at login.
#
# Companion to ingest-server.sh; same shape, same reasons.
# See ~/Library/LaunchAgents/com.ecomscraper.dashboard.plist.

set -euo pipefail

ROOT="/Users/calvin/ecom-scraper"
APP="$ROOT/dashboard"
cd "$APP"

mkdir -p "$ROOT/logs"
chmod 700 "$ROOT/logs"

# Wait for Postgres, but do not require it — see ingest-server.sh for why.
# postgres.js connects lazily too, so Next boots either way and only the
# data-fetching routes fail while the database is down.
deadline=$((SECONDS + 60))
until pg_isready -h 127.0.0.1 -p 5432 -q; do
    if [ "$SECONDS" -ge "$deadline" ]; then
        echo "[$(date -Iseconds)] Postgres not ready after 60s; starting anyway." >&2
        break
    fi
    sleep 2
done

# `next start` serves a build; it does not make one. A missing build is
# therefore a crash loop under KeepAlive, so build once instead.
#
# This only covers the build being *absent* (fresh clone, `rm -rf .next`). It
# does not detect a *stale* one: editing source and restarting keeps serving the
# old build until someone runs `npm run build`. Rebuilding unconditionally would
# fix that, at the cost of a full compile on every login — the wrong trade for a
# dashboard whose source changes rarely.
if [ ! -f ".next/BUILD_ID" ]; then
    echo "[$(date -Iseconds)] no production build found; building"
    npm run build
fi

# exec the Next binary directly, NOT `npm run start`.
#
# npm does not exec its script, it forks one — so launchd would supervise npm
# while the port is held by a next-server grandchild. Verified live: launchd
# tracked pid 2846 (npm) while 127.0.0.1:3100 was bound by pid 2862
# (next-server). Killing the tracked process then orphans the child still
# holding the port, and KeepAlive restarts into `EADDRINUSE` forever.
#
# Exec'ing next means the process launchd watches is the process that owns the
# socket, which is what makes KeepAlive actually work.
echo "[$(date -Iseconds)] starting dashboard on 127.0.0.1:${PORT:-3100}"
exec ./node_modules/.bin/next start --hostname 127.0.0.1 --port "${PORT:-3100}"
