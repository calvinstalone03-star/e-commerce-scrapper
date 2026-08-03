#!/bin/bash
#
# Ask the deployed notifier to check what changed and post it to Telegram.
#
# Run this after a scrape. The notifier itself lives in the Vercel deployment —
# that is where a dashboard link resolves to a host a phone can open — but the
# trigger has to come from here, because Vercel's Hobby plan caps cron jobs at
# once per day and rejects a more frequent expression at deploy time.
#
# Reads NOTIFY_URL and NOTIFY_SECRET from the repo root .env.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$ROOT/.env" ]; then
    echo "no .env at $ROOT — NOTIFY_URL and NOTIFY_SECRET have nowhere to come from" >&2
    exit 2
fi

# Only the two keys this needs, so a malformed line elsewhere in .env cannot be
# executed by a blanket `source`.
NOTIFY_URL="$(grep -E '^NOTIFY_URL=' "$ROOT/.env" | head -1 | cut -d= -f2-)"
NOTIFY_SECRET="$(grep -E '^NOTIFY_SECRET=' "$ROOT/.env" | head -1 | cut -d= -f2-)"

if [ -z "${NOTIFY_URL:-}" ] || [ -z "${NOTIFY_SECRET:-}" ]; then
    echo "NOTIFY_URL or NOTIFY_SECRET missing from $ROOT/.env" >&2
    exit 2
fi

# --fail so a 401 or 503 is a non-zero exit rather than a body printed as if it
# were success. No -v, ever: the Authorization header is on this request.
curl -fsS -X POST \
     -H "Authorization: Bearer ${NOTIFY_SECRET}" \
     -H 'content-type: application/json' \
     "${NOTIFY_URL%/}/api/notify"
echo
