#!/bin/bash
set -e

# Transparent proxy: redirect all outbound HTTPS to host credential proxy.
# iptables requires CAP_NET_ADMIN — dropped by setpriv before agent runs.
# Container is also started with --security-opt=no-new-privileges to prevent
# any child process from re-escalating via setuid/execve after privilege drop.
PROXY_IP=$(getent hosts "$PROXY_HOST" | awk '{print $1}' || echo "$PROXY_HOST")
iptables -t nat -A OUTPUT -p tcp --dport 443 \
  -j DNAT --to-destination "$PROXY_IP:$PROXY_PORT"

# Register MITM CA in system store (for curl, git, chromium)
update-ca-certificates 2>/dev/null

# Compile agent-runner
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Drop ALL capabilities, switch to unprivileged user, run agent.
# If HOST_UID/HOST_GID are set (transparent proxy mode, started as root),
# use setpriv to drop privileges. Otherwise already running as the right user.
if [ -n "$HOST_UID" ]; then
  exec setpriv --reuid=$HOST_UID --regid=${HOST_GID:-$HOST_UID} --clear-groups --inh-caps=-all \
    -- node /tmp/dist/index.js
else
  exec node /tmp/dist/index.js
fi
