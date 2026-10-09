#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

# Configuration validation must not depend on local credentials or create .env.
export XPATHED_PORT=8080
export OPENROUTER_API_KEY=configuration-check-only
docker/compose.sh --env-file /dev/null config --quiet
XPATHED_DEPLOY_DIRECTORY=/tmp/xpathed-hosted-config-check docker/compose.sh --env-file /dev/null -f docker/hosted/compose.security.yaml config --quiet
sh -n docker/hosted/browser-entrypoint.sh
caddy_image=$(awk '/image: caddy@sha256:/ { print $2 }' docker/hosted/compose.security.yaml)
docker run --rm --network none --entrypoint caddy -e XPATHED_HOST=configuration-check.invalid --mount "type=bind,source=$(pwd)/docker/hosted/Caddyfile,target=/etc/caddy/Caddyfile,readonly" "$caddy_image" validate --config /etc/caddy/Caddyfile --adapter caddyfile
nginx_image=$(awk '$1 == "FROM" && $NF == "runtime" { print $2 }' docker/web/Dockerfile)
docker run --rm --network none --entrypoint nginx --add-host browser:127.0.0.1 --add-host client-api:127.0.0.1 --mount "type=bind,source=$(pwd)/docker/web/nginx.conf,target=/etc/nginx/conf.d/default.conf,readonly" "$nginx_image" -t
for dockerfile in docker/*/Dockerfile; do
  docker buildx build --check --target runtime --file "$dockerfile" .
done
