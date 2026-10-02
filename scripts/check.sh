#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

pnpm install --frozen-lockfile
pnpm run --no-bail --aggregate-output '/^check:(dotnet|web|tooling)$/'
