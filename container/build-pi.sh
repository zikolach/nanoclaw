#!/bin/bash
# Build the NanoClaw Pi proof-of-concept container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent-pi"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"
PLATFORM_ARGS=()

if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  PLATFORM_ARGS=(--platform linux/arm64)
fi

echo "Building NanoClaw Pi agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"
if [[ ${#PLATFORM_ARGS[@]} -gt 0 ]]; then
  echo "Platform: ${PLATFORM_ARGS[*]#--platform }"
fi

${CONTAINER_RUNTIME} build "${PLATFORM_ARGS[@]}" -f Dockerfile.pi -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
