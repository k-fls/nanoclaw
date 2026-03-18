#!/bin/bash
# Run a command inside a nanoclaw agent container with iptables proxy redirect.
#
# Usage: ./scripts/run-agent-container.sh <container-name> <timeout-secs> <command> [extra-docker-args...]
#
# Environment (must be set by caller):
#   PROXY_HOST_IP  — numeric IP of the proxy (docker0 bridge IP)
#   PROXY_PORT     — proxy port
#   CA_CERT_PATH   — path to MITM CA cert on host
#   CONTAINER_IMAGE — docker image name
#
# Extra docker args (volumes, env vars) go after the command, prefixed with --.
# Example:
#   ./scripts/run-agent-container.sh test-1 30 "curl https://example.com" -- -e FOO=bar -v /tmp/x:/x:ro

set -euo pipefail

CONTAINER_NAME="$1"
TIMEOUT_SECS="$2"
COMMAND="$3"
shift 3

# Collect extra docker args (everything after --)
EXTRA_ARGS=()
if [ "${1:-}" = "--" ]; then
  shift
  EXTRA_ARGS=("$@")
fi

: "${PROXY_HOST_IP:?PROXY_HOST_IP must be set}"
: "${PROXY_PORT:?PROXY_PORT must be set}"
: "${CA_CERT_PATH:?CA_CERT_PATH must be set}"
: "${CONTAINER_IMAGE:?CONTAINER_IMAGE must be set}"

# Build docker args
DOCKER_ARGS=(
  run -i --rm
  --name "$CONTAINER_NAME"
  --cap-add=NET_ADMIN
  -e "PROXY_HOST=$PROXY_HOST_IP"
  -e "PROXY_PORT=$PROXY_PORT"
  -v "$CA_CERT_PATH:/usr/local/share/ca-certificates/nanoclaw-mitm.crt:ro"
  -e "NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/nanoclaw-mitm.crt"
)

# Linux needs explicit host gateway mapping
if [ "$(uname)" = "Linux" ]; then
  DOCKER_ARGS+=(--add-host=host.docker.internal:host-gateway)
fi

# Caller's extra args (env vars, volumes, etc.)
DOCKER_ARGS+=("${EXTRA_ARGS[@]}")

DOCKER_ARGS+=(
  --entrypoint ""
  "$CONTAINER_IMAGE"
  /bin/bash -c
  "PROXY_IP=\$(getent hosts \$PROXY_HOST | awk '{print \$1}' || echo \$PROXY_HOST) && \
   iptables -t nat -A OUTPUT -p tcp --dport 443 -j DNAT --to-destination \$PROXY_IP:\$PROXY_PORT && \
   update-ca-certificates 2>/dev/null && \
   $COMMAND"
)

# Get container IP after it starts (background)
get_ip() {
  for i in $(seq 1 20); do
    sleep 0.5
    IP=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)
    if [ -n "$IP" ]; then
      echo "$IP"
      return
    fi
  done
}

# Write container IP to fd 3 if it's open (for the test harness to read)
if { true >&3; } 2>/dev/null; then
  get_ip >&3 &
fi

# Run with timeout
timeout "$TIMEOUT_SECS" docker "${DOCKER_ARGS[@]}"
EXIT_CODE=$?

# Clean up container if timeout killed it
if [ $EXIT_CODE -eq 124 ]; then
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
fi

exit $EXIT_CODE
