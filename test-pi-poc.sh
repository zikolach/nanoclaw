#!/bin/bash

set -e

echo "=== NanoClaw Pi proof-of-concept smoke test ==="

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running"
  exit 1
fi

PI_PROVIDER_VALUE="${PI_PROVIDER:-llamabarn}"
PI_MODEL_VALUE="${PI_MODEL:-}"
PI_API_KEY_VALUE="${PI_API_KEY:-dummy-key}"

echo "Building Pi image..."
./container/build-pi.sh

DOCKER_ARGS=(run -i --add-host=host.docker.internal:host-gateway -e PI_PROVIDER="$PI_PROVIDER_VALUE")

if [ -n "${PI_BASE_URL:-}" ]; then
  : "${PI_MODEL_VALUE:?Set PI_MODEL when using PI_BASE_URL}"
  DOCKER_ARGS+=(-e PI_BASE_URL="$PI_BASE_URL" -e PI_MODEL="$PI_MODEL_VALUE" -e PI_API_KEY="$PI_API_KEY_VALUE")
  echo "Running local/custom provider smoke test..."
else
  PI_PROVIDER_VALUE="${PI_PROVIDER_VALUE:-openai-codex}"
  if [ -z "$PI_MODEL_VALUE" ]; then
    PI_MODEL_VALUE="gpt-5.2-codex"
  fi
  DOCKER_ARGS=(run -i --add-host=host.docker.internal:host-gateway -v "$HOME/.pi/agent/auth.json:/home/node/.pi/agent/auth.json:ro" -e PI_PROVIDER="$PI_PROVIDER_VALUE" -e PI_MODEL="$PI_MODEL_VALUE")
  echo "Running built-in provider smoke test..."
fi

echo '{"prompt":"Reply with the single word pong.","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | docker "${DOCKER_ARGS[@]}" nanoclaw-agent-pi:latest
