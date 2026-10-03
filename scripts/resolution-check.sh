#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

mode=${1:---deterministic}
case "$mode" in --deterministic|--live) ;; *) echo "Use --deterministic or --live" >&2; exit 1 ;; esac
if [ -z "${XPATHED_ENV_FILE:-}" ]; then
  scripts/setup.sh
fi
resolution_env=${XPATHED_ENV_FILE:-.env}
# Use a separate stack and loopback port.
export COMPOSE_PROJECT_NAME=xpathed-resolution
export XPATHED_PORT=${XPATHED_TEST_PORT:-8081}
compose() {
  if [ "$mode" = --live ]; then
    docker/compose.sh --env-file "$resolution_env" -f docker/compose.resolution-check.yaml -f docker/compose.resolution-live.yaml "$@"
  else
    docker/compose.sh --env-file "$resolution_env" -f docker/compose.resolution-check.yaml "$@"
  fi
}
compose down
trap 'compose down' EXIT
if [ "$mode" = --live ]; then
  # Prove the direct resolver path without running the client.
  compose up --build --wait browser resolver resolution-fixture
  compose exec -T resolution-fixture node ready.mjs http://browser:8080/health http://resolver:8080/health http://resolution-fixture:8090/health
  compose exec -T resolution-fixture node --test live.test.mjs
else
  compose up --build --wait
  compose exec -T resolution-fixture node ready.mjs http://browser:8080/health http://resolver:8080/health http://resolution-fixture:8090/health http://client-api:8080/health
  compose exec -T -e XPATHED_VIEWER_ORIGIN="http://localhost:$XPATHED_PORT" resolution-fixture node --test browser.test.mjs pipeline.test.mjs
fi
