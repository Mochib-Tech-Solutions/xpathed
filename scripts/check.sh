#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

pnpm install --frozen-lockfile
pnpm check:dotnet
pnpm check:web
pnpm check:tooling
