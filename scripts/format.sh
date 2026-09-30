#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

action=${1:---write}
scope=${2:-all}
case "$action" in --check|--write) ;; *) echo "Expected --check or --write" >&2; exit 1 ;; esac
case "$scope" in all|dotnet|web|tooling) ;; *) echo "Expected all, dotnet, web, or tooling" >&2; exit 1 ;; esac

if [ "$scope" = all ] || [ "$scope" = dotnet ]; then
  dotnet tool restore
  if [ "$action" = --check ]; then
    dotnet format style Xpathed.slnx --no-restore --verify-no-changes
    dotnet csharpier check src tests
  else
    dotnet format style Xpathed.slnx
    dotnet csharpier format src tests
  fi
fi
if [ "$scope" = all ] || [ "$scope" = web ]; then
  if [ "$action" = --check ]; then pnpm --filter xpathed format:check; else pnpm --filter xpathed format; fi
fi
if [ "$scope" = all ] || [ "$scope" = tooling ]; then
  pnpm exec prettier "$action" package.json .prettierrc.json global.json '.config/*.json' pnpm-workspace.yaml 'docker/*.yaml' 'docker/**/*.json' '.github/workflows/*.yml' 'scripts/*.mjs' 'tests/resolution/*.mjs' 'evaluation/**/*.{mjs,js,json}'
fi
