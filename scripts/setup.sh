#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  umask 077
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env
  printf 'Created local .env with a generated database password.\n'
fi
