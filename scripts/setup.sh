#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  umask 077
  cp .env.example .env
  printf 'Created local .env from .env.example.\n'
fi
