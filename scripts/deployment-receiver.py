"""Installed outside uploaded source; the CI SSH key can invoke only this receiver."""
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile


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
        subprocess.run(["python3", str(source / "scripts/deployment-host.py"),
                        str(base), str(source), revision, fingerprint], check=True)
    finally:
        shutil.rmtree(directory)


if __name__ == "__main__":
    os.umask(0o077)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    receive(Path.home() / "xpathed", os.environ.get("SSH_ORIGINAL_COMMAND", ""), sys.stdin.buffer)
