#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

project_dir=$(node -p 'process.cwd()')
exec docker compose --project-directory "$project_dir" -f "$project_dir/docker/compose.yaml" "$@"
