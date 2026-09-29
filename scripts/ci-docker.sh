#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

# Configuration validation must not depend on local credentials or create .env.
export POSTGRES_PASSWORD=configuration-check-only
export XPATHED_PORT=8080
docker/compose.sh --env-file /dev/null config --quiet
docker/compose.sh --dev --env-file /dev/null config --quiet
for dockerfile in docker/*/Dockerfile; do
  for target in runtime development; do
    docker buildx build --check --target "$target" --file "$dockerfile" .
  done
done
