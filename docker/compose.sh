#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

# Canonical casing keeps macOS file events aligned with Compose Watch paths.
project_dir=$(node -p 'process.cwd()')
if [ "${1:-}" = --dev ]; then
  shift
  set -- -f "$project_dir/docker/compose.dev.yaml" "$@"
fi
exec docker compose --project-directory "$project_dir" -f "$project_dir/docker/compose.yaml" "$@"
