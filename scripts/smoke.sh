#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
scripts/setup.sh
mkdir -p artifacts/smoke
# The non-root test container writes only controlled fixture screenshots here.
chmod 777 artifacts/smoke
docker compose up -d

wait_for_app() {
  attempts=0
  until curl -fsS "http://localhost:${XPATHED_PORT:-8080}/health" > /dev/null &&
    docker compose exec -T browser curl -fsS http://127.0.0.1:8080/health > /dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      echo 'Application did not become healthy.' >&2
      return 1
    fi
    sleep 1
  done
}
wait_for_app
docker compose run --rm -T --no-deps \
  -v "$PWD/artifacts/smoke:/evidence" -e EVIDENCE_DIR=/evidence smoke
previous_page=$(docker compose run --rm -T --no-deps smoke --seed-restart)
docker compose restart browser
wait_for_app
docker compose run --rm -T --no-deps smoke --verify-restart "$previous_page"
