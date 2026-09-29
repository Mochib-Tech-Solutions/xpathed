#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--check" ]; then
  dotnet format Xpathed.slnx --no-restore --verify-no-changes
  npm --prefix src/Web run format:check
  action=--check
else
  dotnet format Xpathed.slnx
  npm --prefix src/Web run format
  action=--write
fi
npm --prefix src/Web exec -- prettier "$action" package.json .prettierrc.json global.json 'compose*.yaml' 'infra/*.json' '.github/workflows/*.yml' 'scripts/*.mjs'
