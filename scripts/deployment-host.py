"""Build native releases before switching systemd services; recover a failed switch."""

import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

SERVICES = {"browser": "Browser", "resolver": "Resolver", "client-api": "ClientApi"}
RUNTIME = Path("/opt/xpathed")


def command(*args, **kwargs):
    subprocess.run(args, check=True, stdout=sys.stderr, **kwargs)


def build(base, state):
    source = Path(state["source"])
    output = source / "runtime"
    cache = source / ".build"
    environment = {
        **os.environ,
        "DOTNET_CLI_HOME": str(cache / "dotnet-home"),
        "NUGET_PACKAGES": str(cache / "nuget"),
        "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
        "DOTNET_NOLOGO": "1",
    }
    for name, project in SERVICES.items():
        path = f"src/{project}/{project}.csproj"
        command("/opt/dotnet/dotnet", "restore", path, "--locked-mode", cwd=source, env=environment)
        command(
            "/opt/dotnet/dotnet",
            "publish",
            path,
            "--no-restore",
            "--configuration",
            "Release",
            "-p:UseAppHost=false",
            "--output",
            str(output / name),
            cwd=source,
            env=environment,
        )
    command(
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--store-dir",
        str(cache / "pnpm"),
        cwd=source,
    )
    command("pnpm", "build:web", cwd=source)
    shutil.copytree(source / "src/Web/dist", output / "web")
    shutil.copytree(source / "hosted", output / "hosted")
    command(
        "sudo",
        "-n",
        "env",
        "XPATHED_HOST=" + urlsplit((base / "deploy/public-url").read_text().strip()).hostname,
        "caddy",
        "validate",
        "--config",
        str(output / "hosted/Caddyfile"),
        "--adapter",
        "caddyfile",
    )
    # Only immutable compiled files reach the service accounts; no source or build cache.
    destination = RUNTIME / "releases" / state["revision"]
    if destination.exists():
        receipt = json.loads((destination / "release.json").read_text())
        if receipt != {"revision": state["revision"], "fingerprint": state["fingerprint"]}:
            raise RuntimeError("Native release identity mismatch")
        return
    (output / "release.json").write_text(
        json.dumps({"revision": state["revision"], "fingerprint": state["fingerprint"]})
    )
    temporary = destination.with_suffix(".tmp")
    command("sudo", "-n", "rm", "-rf", "--", str(temporary))
    command("sudo", "-n", "cp", "-a", str(output), str(temporary))
    command("sudo", "-n", "chown", "-R", "root:root", str(temporary))
    command("sudo", "-n", "chmod", "-R", "a+rX", str(temporary))
    command("sudo", "-n", "mv", str(temporary), str(destination))


def native(base, state, action):
    if action == "build":
        build(base, state)
    elif action == "switch":
        destination = RUNTIME / "releases" / state["revision"]
        command("sudo", "-n", "ln", "-sfn", str(destination), str(RUNTIME / "next"))
        command("sudo", "-n", "mv", "-Tf", str(RUNTIME / "next"), str(RUNTIME / "current"))
        for name in (*SERVICES, "network"):
            command(
                "sudo",
                "-n",
                "install",
                "-m",
                "644",
                str(destination / f"hosted/xpathed-{name}.service"),
                f"/etc/systemd/system/xpathed-{name}.service",
            )
        command("sudo", "-n", "systemctl", "daemon-reload")
        command("sudo", "-n", "systemctl", "restart", *("xpathed-" + name for name in SERVICES))
        command("sudo", "-n", "systemctl", "reload-or-restart", "caddy")
    elif action == "stop":
        command("sudo", "-n", "systemctl", "stop", *("xpathed-" + name for name in SERVICES))
    else:
        raise ValueError("Unknown native deployment action")


def healthy(base, state):
    for port in (18081, 18082, 18083):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=10) as response:
            if response.status != 200:
                raise RuntimeError("Native service health check failed")
    url = (base / "deploy/public-url").read_text().strip()
    for path in ("/", "/health", "/view/health"):
        with urllib.request.urlopen(url + path, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError("Hosted health check failed")
            if (
                response.headers.get("X-Frame-Options") != "DENY"
                or response.headers.get("X-Content-Type-Options") != "nosniff"
                or "object-src 'none'" not in response.headers.get("Content-Security-Policy", "")
                or not response.headers.get("Strict-Transport-Security")
            ):
                raise RuntimeError("Hosted security headers are missing")
    command("sudo", "-n", "python3", "/usr/local/lib/xpathed/network-policy.py", "--verify")


def wait_healthy(base, state, check=healthy):
    for attempt in range(12):
        try:
            check(base, state)
            return
        except (OSError, RuntimeError, subprocess.CalledProcessError):
            if attempt == 11:
                raise
            time.sleep(5)


def cleanup(base, current, previous):
    retained = {state["revision"] for state in (current, previous) if state}
    for directory in (RUNTIME / "releases").iterdir():
        if re.fullmatch(r"[a-f0-9]{40}", directory.name) and directory.name not in retained:
            command("sudo", "-n", "rm", "-rf", "--", str(directory))
    # Successful native releases retain compiled recovery files, not source/build caches.
    for directory in (base / "deployments").iterdir():
        if re.fullmatch(r"[a-f0-9]{40}", directory.name) and not directory.is_symlink():
            shutil.rmtree(directory)


def deploy(base, source, revision, fingerprint, run=native, check=wait_healthy, clean=cleanup):
    if not re.fullmatch(r"[a-f0-9]{40}", revision) or not re.fullmatch(
        r"[a-f0-9]{64}", fingerprint
    ):
        raise ValueError("Invalid pinned deployment identity")
    state_path = base / "deploy/current.json"
    previous = json.loads(state_path.read_text()) if state_path.exists() else None
    if previous and previous.get("runtime") != "native":
        raise RuntimeError("Provision and migrate the host before deploying native releases")
    if previous and previous["fingerprint"] == fingerprint:
        check(base, previous)
        print(json.dumps({"status": "unchanged", "revision": previous["revision"]}))
        return
    release = base / "deployments" / revision
    release.parent.mkdir(exist_ok=True)
    if release.exists():
        if release.is_symlink():
            raise RuntimeError("Source release must not be a symlink")
        shutil.rmtree(release)
    shutil.copytree(source, release)
    candidate = {
        "revision": revision,
        "fingerprint": fingerprint,
        "source": str(release),
        "runtime": "native",
    }
    # A failed build cannot change running services or a successful receipt.
    run(base, candidate, "build")
    try:
        run(base, candidate, "switch")
        check(base, candidate)
        temporary = state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(candidate, indent=2) + "\n")
        if previous:
            recovery = base / "deploy/previous.tmp"
            recovery.write_text(json.dumps(previous, indent=2) + "\n")
            recovery.replace(base / "deploy/previous.json")
        temporary.replace(state_path)
    except BaseException:
        print("Deployment failed; restoring the previous native release.", file=sys.stderr)
        if previous:
            run(base, previous, "switch")
            check(base, previous)
        else:
            run(base, candidate, "stop")
        raise
    print(json.dumps({"status": "deployed", "revision": revision, "fingerprint": fingerprint}))
    try:
        clean(base, candidate, previous)
    except (OSError, subprocess.CalledProcessError) as error:
        print(
            f"Cleanup incomplete ({type(error).__name__}); application remains deployed.",
            file=sys.stderr,
        )


if __name__ == "__main__":
    os.umask(0o077)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    base, source, revision, fingerprint = sys.argv[1:]
    with (Path(base) / "deploy/deployment.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        deploy(Path(base), Path(source), revision, fingerprint)
