#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

# Configuration validation must not depend on local credentials or create .env.
export POSTGRES_PASSWORD=configuration-check-only
export XPATHED_PORT=8080
docker compose --env-file /dev/null -f compose.yaml config --quiet
docker compose --env-file /dev/null -f compose.yaml -f compose.dev.yaml config --quiet
for dockerfile in src/*/Dockerfile; do
  for target in runtime development; do
    docker buildx build --check --target "$target" --file "$dockerfile" .
  done
done
