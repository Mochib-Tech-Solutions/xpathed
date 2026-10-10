"""Administrative provisioning for an Ubuntu x86-64 native host; starts no application."""

import hashlib
import json
import os
import platform
import pwd
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def download(url, path):
    with urllib.request.urlopen(url, timeout=120) as response, path.open("wb") as output:
        shutil.copyfileobj(response, output)


def provision(source, base):
    if (
        os.geteuid() != 0
        or platform.machine() != "x86_64"
        or 'VERSION_ID="26.04"' not in Path("/etc/os-release").read_text()
    ):
        raise RuntimeError("Run as root on Ubuntu 26.04 x86-64")
    config = Path("/etc/xpathed")
    config.mkdir(mode=0o700, exist_ok=True)
    # The administrator keeps provider and origin configuration private.
    for name in ("browser.env", "resolver.env", "client-api.env", "gateway.env", "public-url"):
        if not (config / name).is_file():
            raise RuntimeError("Prepare /etc/xpathed/" + name + " before provisioning")
        (config / name).chmod(0o600)
    url = (config / "public-url").read_text().strip()
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.path not in ("", "/")
    ):
        raise ValueError("Invalid public origin")
    run("systemctl", "mask", "--runtime", "caddy.service")
    environment = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
    run("apt-get", "update", env=environment)
    run(
        "apt-get",
        "install",
        "-y",
        "--no-install-recommends",
        "ca-certificates",
        "curl",
        "gnupg",
        "nftables",
        "libicu78",
        "libssl3t64",
        "libstdc++6",
        "fonts-liberation",
        "fonts-noto-color-emoji",
        env=environment,
    )
    with tempfile.TemporaryDirectory(prefix="xpathed-provision-") as temporary:
        temporary = Path(temporary)
        for name, key_url, repository in [
            (
                "chrome",
                "https://dl.google.com/linux/linux_signing_key.pub",
                "deb [arch=amd64 signed-by=/usr/share/keyrings/xpathed-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main",
            ),
        ]:
            key = temporary / (name + ".key")
            download(key_url, key)
            run(
                "gpg",
                "--batch",
                "--yes",
                "--dearmor",
                "--output",
                f"/usr/share/keyrings/xpathed-{name}.gpg",
                str(key),
            )
            Path(f"/etc/apt/sources.list.d/xpathed-{name}.list").write_text(repository + "\n")
        run("apt-get", "update", env=environment)
        run(
            "apt-get",
            "install",
            "-y",
            "--no-install-recommends",
            "caddy",
            "google-chrome-stable",
            env=environment,
        )
        sdk = json.loads((source / "global.json").read_text())["sdk"]["version"]
        metadata = temporary / "releases.json"
        download(
            "https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json",
            metadata,
        )
        files = [
            item
            for release in json.loads(metadata.read_text())["releases"]
            for candidate in release.get("sdks", [])
            if candidate["version"] == sdk
            for item in candidate["files"]
            if item["rid"] == "linux-x64" and item["name"].endswith("tar.gz")
        ]
        if len(files) != 1:
            raise RuntimeError("Pinned SDK unavailable in official release metadata")
        archive = temporary / "dotnet.tar.gz"
        download(files[0]["url"], archive)
        if hashlib.sha512(archive.read_bytes()).hexdigest() != files[0]["hash"].lower():
            raise RuntimeError("SDK checksum mismatch")
        Path("/opt/dotnet").mkdir(exist_ok=True)
        with tarfile.open(archive) as bundle:
            bundle.extractall("/opt/dotnet", filter="data")
        node = json.loads((source / "package.json").read_text())["engines"]["node"].lstrip("^")
        filename = f"node-v{node}-linux-x64.tar.xz"
        checksums = temporary / "checksums"
        download(f"https://nodejs.org/dist/v{node}/SHASUMS256.txt", checksums)
        expected = next(
            line.split()[0]
            for line in checksums.read_text().splitlines()
            if line.endswith("  " + filename)
        )
        archive = temporary / filename
        download(f"https://nodejs.org/dist/v{node}/{filename}", archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise RuntimeError("Node checksum mismatch")
        with tarfile.open(archive) as bundle:
            bundle.extractall(temporary, filter="data")
        target = Path("/opt/xpathed-node")
        if target.exists():
            shutil.rmtree(target)
        shutil.move(temporary / filename.removesuffix(".tar.xz"), target)
        for name in ("node", "npm", "npx"):
            path = Path("/usr/local/bin") / name
            if path.is_symlink():
                path.unlink()
            path.symlink_to(target / "bin" / name)
        pnpm = json.loads((source / "package.json").read_text())["packageManager"]
        run("/usr/local/bin/npm", "install", "--global", "--prefix", "/usr/local", pnpm)
    for name in ("browser", "resolver", "client-api"):
        try:
            pwd.getpwnam("xpathed-" + name)
        except KeyError:
            run(
                "useradd",
                "--system",
                "--user-group",
                "--home-dir",
                "/nonexistent",
                "--shell",
                "/usr/sbin/nologin",
                "xpathed-" + name,
            )
    Path("/opt/xpathed/releases").mkdir(parents=True, exist_ok=True)
    helper = Path("/usr/local/lib/xpathed")
    helper.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / "scripts/deployment-network.py", helper / "network-policy.py")
    for unit in (source / "hosted").glob("xpathed-*.service"):
        shutil.copyfile(unit, Path("/etc/systemd/system") / unit.name)
    dropin = Path("/etc/systemd/system/caddy.service.d")
    dropin.mkdir(exist_ok=True)
    shutil.copyfile(source / "hosted/caddy.conf", dropin / "xpathed.conf")
    caddyfile = Path("/etc/caddy/Caddyfile")
    if caddyfile.exists() or caddyfile.is_symlink():
        caddyfile.unlink()
    caddyfile.symlink_to("/opt/xpathed/current/hosted/Caddyfile")
    run("systemctl", "unmask", "--runtime", "caddy.service")
    run("systemctl", "daemon-reload")
    run(
        "systemctl",
        "enable",
        "xpathed-network",
        "xpathed-browser",
        "xpathed-resolver",
        "xpathed-client-api",
        "caddy",
    )
    run("systemctl", "restart", "xpathed-network")
    shutil.copyfile(source / "scripts/deployment-receiver.py", base / "deploy/receiver.py")
    print("Native host provisioned; application services await a verified release.")


if __name__ == "__main__":
    provision(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
