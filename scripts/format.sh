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
  pnpm exec prettier "$action" . --ignore-unknown
  python_tools=.artifacts/python-tools
  if [ ! -x "$python_tools/bin/python" ]; then python3 -m venv "$python_tools"; fi
  "$python_tools/bin/python" -m pip install --quiet --disable-pip-version-check -r scripts/requirements-dev.txt
  if [ "$action" = --check ]; then
    "$python_tools/bin/python" -m ruff check scripts
    "$python_tools/bin/python" -m ruff format --check scripts
  else
    "$python_tools/bin/python" -m ruff check --fix scripts
    "$python_tools/bin/python" -m ruff format scripts
  fi
fi
