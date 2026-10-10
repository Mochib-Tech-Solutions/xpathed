"""Installed outside uploaded source; the CI SSH key can invoke only this receiver."""

import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlsplit


def forward_output(base, command):
    url = (base / "deploy/public-url").read_text().strip()
    addresses = [url, urlsplit(url).hostname]
    private_values = base / "deploy/private-log-values"
    if private_values.exists():
        addresses += private_values.read_text().splitlines()
    pattern = re.compile("|".join(re.escape(value) for value in addresses if value), re.IGNORECASE)
    lock = threading.Lock()
    output_open = True

    def forward(stream):
        nonlocal output_open
        for line in stream:
            with lock:
                if output_open:
                    try:
                        print(pattern.sub("[deployment address]", line), end="", flush=True)
                    except OSError:
                        # Continue draining the worker if the SSH client disconnects.
                        output_open = False

    with subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace"
    ) as process:
        readers = [
            threading.Thread(target=forward, args=(stream,))
            for stream in (process.stdout, process.stderr)
        ]
        for reader in readers:
            reader.start()
        for reader in readers:
            reader.join()
        status = process.wait()
        if status != 0:
            if output_open:
                print(f"Deployment worker exited with status {status}.", flush=True)
            raise RuntimeError("Deployment worker failed; inspect the redacted output")


def receive(base, command, stream):
    match = re.fullmatch(r"deploy ([a-f0-9]{40}) ([a-f0-9]{64})", command)
    if not match:
        raise ValueError("Only a pinned deployment is accepted")
    revision, fingerprint = match.groups()
    incoming = base / "incoming"
    incoming.mkdir(mode=0o700, exist_ok=True)
    directory = Path(tempfile.mkdtemp(dir=incoming))
    try:
        archive = directory / "source.tar"
        with archive.open("wb") as output:
            remaining = 64 * 1024 * 1024
            while chunk := stream.read(min(1024 * 1024, remaining + 1)):
                remaining -= len(chunk)
                if remaining < 0:
                    raise ValueError("Deployment archive exceeds limit")
                output.write(chunk)
        source = directory / "source"
        source.mkdir()
        with tarfile.open(archive) as bundle:
            bundle.extractall(source, filter="data")
        forward_output(
            base,
            [
                "python3",
                str(source / "scripts/deployment-host.py"),
                str(base),
                str(source),
                revision,
                fingerprint,
            ],
        )
    finally:
        shutil.rmtree(directory)


if __name__ == "__main__":
    os.umask(0o077)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    try:
        receive(
            Path.home() / "xpathed", os.environ.get("SSH_ORIGINAL_COMMAND", ""), sys.stdin.buffer
        )
    except Exception as error:
        print(
            f"Deployment receiver failed ({type(error).__name__}); inspect the redacted output.",
            file=sys.stderr,
        )
        sys.exit(1)
