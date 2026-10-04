#!/bin/sh
set -eu
# The host installs packet filters before releasing this invocation. A fresh nonce
# prevents a stopped/restarted container from reusing its previous readiness file.
nonce=$(cat /proc/sys/kernel/random/uuid)
printf '%s' "$nonce" > /tmp/.xpathed-egress-wait
until [ "$(cat /tmp/.xpathed-egress-ready 2>/dev/null || true)" = "$nonce" ]; do
    sleep 1
done
exec "$@"
