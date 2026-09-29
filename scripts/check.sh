#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

npm run setup
npm run format:check
npm run lint
npm run build
npm run test:unit
