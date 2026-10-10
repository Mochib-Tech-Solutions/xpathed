#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

XPATHED_HOST=configuration-check.invalid caddy validate --config hosted/Caddyfile --adapter caddyfile
# systemd's syntax validator checks executable existence, but never runs it.
sudo install -d /opt/dotnet
sudo ln -sf /usr/bin/true /opt/dotnet/dotnet
systemd-analyze verify hosted/xpathed-*.service
python3 -B scripts/deployment-network.test.py
policy=$(mktemp)
trap 'rm -f "$policy"' EXIT HUP INT TERM
python3 - "$policy" <<'PYTHON'
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("network", "scripts/deployment-network.py")
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)
pathlib.Path(sys.argv[1]).write_text(network.rules(1234, ["8.8.4.4"]))
PYTHON
sudo nft --check --file "$policy"
