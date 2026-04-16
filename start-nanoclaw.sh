#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /home/nanoclaw/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/home/nanoclaw/nanoclaw"

# Stop existing instance if running
if [ -f "/home/nanoclaw/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/home/nanoclaw/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/usr/bin/node" "/home/nanoclaw/nanoclaw/dist/index.js" \
  >> "/home/nanoclaw/nanoclaw/logs/nanoclaw.log" \
  2>> "/home/nanoclaw/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/home/nanoclaw/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /home/nanoclaw/nanoclaw/logs/nanoclaw.log"
