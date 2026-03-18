#!/bin/bash
# Kill any running test processes and containers
pkill -f 'test-transparent-proxy' 2>/dev/null || true
for id in $(docker ps -q --filter name=nanoclaw-test 2>/dev/null); do
  docker rm -f "$id" 2>/dev/null
done
echo "Cleanup done"
