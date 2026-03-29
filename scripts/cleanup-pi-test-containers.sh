#!/bin/bash

set -euo pipefail

# Remove any leftover containers created from the experimental Pi runtime image.
ids=$(docker ps -aq --filter ancestor=nanoclaw-agent-pi:latest)
if [ -z "$ids" ]; then
  echo "No Pi test containers found."
  exit 0
fi

echo "$ids" | xargs docker rm -f
echo "Removed Pi test containers."
