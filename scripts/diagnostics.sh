#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "${1:-}" = -- ]; then shift; fi
exec docker/compose.sh exec -T client-api sh -c '
  if [ -f /app/ClientApi.dll ]; then
    exec dotnet /app/ClientApi.dll diagnostics "$@"
  fi
  exec dotnet /source/src/ClientApi/bin/Debug/net10.0/ClientApi.dll diagnostics "$@"
' diagnostics "$@"
