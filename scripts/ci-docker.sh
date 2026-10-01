#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

# Configuration validation must not depend on local credentials or create .env.
export POSTGRES_PASSWORD=configuration-check-only
export XPATHED_PORT=8080
export OPENROUTER_API_KEY=configuration-check-only
export OPENROUTER_EVAL_API_KEY=configuration-check-only
export XPATHED_EVALUATION_OUTPUT=/tmp/xpathed-evaluation-config-check
docker/compose.sh --env-file /dev/null config --quiet
docker/compose.sh --dev --env-file /dev/null config --quiet
docker/compose.sh --env-file /dev/null -f docker/compose.resolution-check.yaml config --quiet
docker/compose.sh --env-file /dev/null -f docker/compose.resolution-check.yaml -f docker/compose.resolution-live.yaml config --quiet
docker/compose.sh --env-file /dev/null -f docker/compose.evaluation.yaml config --quiet
docker/compose.sh --env-file /dev/null -f docker/compose.evaluation.yaml -f docker/compose.evaluation-live.yaml config --quiet
docker/compose.sh --env-file /dev/null -f docker/compose.evaluation.yaml -f docker/compose.comparison.yaml config --quiet
docker/compose.sh --env-file /dev/null -f docker/compose.evaluation.yaml -f docker/compose.qualification.yaml config --quiet
docker/compose.sh --env-file /dev/null -f docker/compose.evaluation.yaml -f docker/compose.context.yaml config --quiet
docker buildx build --check --file docker/stagehand.Dockerfile .
for dockerfile in docker/*/Dockerfile; do
  for target in runtime development; do
    docker buildx build --check --target "$target" --file "$dockerfile" .
  done
done
