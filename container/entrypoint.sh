#!/bin/bash
set -e

# Transparent proxy: redirect all outbound HTTPS to host proxy.
# iptables requires CAP_NET_ADMIN — dropped by setpriv before agent runs.
# Container is also started with --security-opt=no-new-privileges to prevent
# any child process from re-escalating via setuid/execve after privilege drop.
if [ -n "$PROXY_HOST" ] && [ -n "$PROXY_PORT" ]; then
  PROXY_IP=$(getent hosts "$PROXY_HOST" | awk '{print $1}' || echo "$PROXY_HOST")
  iptables -t nat -A OUTPUT -p tcp --dport 443 \
    -j DNAT --to-destination "$PROXY_IP:$PROXY_PORT"
fi

# Register MITM CA in system store (for curl, git, chromium)
if [ -f /usr/local/share/ca-certificates/nanoclaw-mitm.crt ]; then
  update-ca-certificates 2>/dev/null
fi

# Compile agent-runner
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Drop ALL capabilities, switch to unprivileged user, run agent
exec setpriv --reuid=node --regid=node --clear-groups --inh-caps=-all \
  -- node /tmp/dist/index.js
