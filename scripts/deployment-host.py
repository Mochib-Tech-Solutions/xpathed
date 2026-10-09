"""Build pinned source before switching the existing Compose project; restore on failure."""
import fcntl
import json
import os
import re
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

SERVICES = ("browser", "resolver", "client-api", "web")


def obsolete_images(references, current):
    pattern = r"xpathed/(browser|resolver|client-api|web):([a-f0-9]{40})"
    return {reference for reference in references
            if (match := re.fullmatch(pattern, reference)) and match.group(2) != current["revision"]}


def cleanup(current):
    def output(*args):
        return subprocess.check_output(["sudo", "-n", "docker", *args], text=True).splitlines()
    references = output("image", "ls", "--format", "{{.Repository}}:{{.Tag}}")
    obsolete = obsolete_images(references, current)
    # Remove only stopped containers belonging to this stack and obsolete source images.
    containers = output("ps", "-a", "--filter", "label=com.docker.compose.project=xpathed-hosted",
                        "--filter", "status=exited", "--filter", "status=dead",
                        "--format", "{{.ID}} {{.Image}}")
    for container in containers:
        identity, reference = container.split()
        if reference in obsolete:
            subprocess.run(["sudo", "-n", "docker", "container", "rm", identity], check=True)
    for reference in sorted(obsolete):
        # Docker refuses removal of an image still used by any container. Never force it.
        subprocess.run(["sudo", "-n", "docker", "image", "rm", reference], check=True)
    print(json.dumps({"cleanup": "completed", "obsoleteImageReferences": len(obsolete)}))


def cleanup_safely(current):
    try:
        cleanup(current)
    except (OSError, subprocess.CalledProcessError) as error:
        # Cleanup failure must not roll back an already healthy application.
        print(f"Cleanup incomplete ({type(error).__name__}); application remains deployed.", file=sys.stderr)


def compose(base, state, *arguments):
    command = ["sudo", "-n", "docker", "compose", "-p", "xpathed-hosted",
               "--project-directory", state["source"], "--env-file", str(base / "deploy/application.env"),
               "-f", str(Path(state["source"]) / "docker/compose.yaml"),
               "-f", str(base / "deploy/compose.hosted.yaml")]
    if state.get("override"):
        command += ["-f", state["override"]]
    subprocess.run(command + list(arguments), check=True, stdout=sys.stderr)


def healthy(base, state):
    url = (base / "deploy/public-url").read_text().strip()
    for path in ("/", "/health", "/view/health"):
        with urllib.request.urlopen(url + path, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError("Hosted health check failed")
            if (response.headers.get("X-Frame-Options") != "DENY"
                    or response.headers.get("X-Content-Type-Options") != "nosniff"
                    or "object-src 'none'" not in response.headers.get("Content-Security-Policy", "")
                    or not response.headers.get("Strict-Transport-Security")):
                raise RuntimeError("Hosted security headers are missing")
    subprocess.run(["sudo", "-n", "python3", "/usr/local/lib/xpathed/network-policy.py", "--verify"], check=True)
    compose(base, state, "exec", "-T", "web", "wget", "-q", "-O", "/dev/null", "http://resolver:8080/health")


def wait_healthy(base, state, check=healthy):
    for attempt in range(12):
        try:
            check(base, state)
            return
        except (OSError, RuntimeError, subprocess.CalledProcessError):
            if attempt == 11:
                raise
            time.sleep(5)


def deploy(base, source, revision, fingerprint, run=compose, check=wait_healthy, clean=cleanup_safely):
    state_path = base / "deploy/current.json"
    previous = json.loads(state_path.read_text())
    if previous["fingerprint"] == fingerprint:
        check(base, previous)
        clean(previous)
        print(json.dumps({"status": "unchanged", "revision": previous["revision"]}))
        return
    release = base / "deployments" / revision
    release.parent.mkdir(exist_ok=True)
    if release.exists():
        if str(release) == previous["source"]:
            raise RuntimeError("Refusing to overwrite the active source")
        shutil.rmtree(release)
    shutil.copytree(source, release)
    override = release / "deployment-images.json"
    override.write_text(json.dumps({"services": {
        name: {"image": f"xpathed/{name}:{revision}",
               "labels": {"org.opencontainers.image.revision": revision}}
        for name in SERVICES}}))
    candidate = {"revision": revision, "fingerprint": fingerprint,
                 "source": str(release), "override": str(override)}
    # A failed build leaves the running stack and successful receipt untouched.
    run(base, candidate, "build", *SERVICES)
    try:
        run(base, candidate, "up", "-d", "--no-build", "--remove-orphans")
        check(base, candidate)
        temporary = state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(candidate, indent=2) + "\n")
        temporary.replace(state_path)
    except BaseException:
        print("Deployment failed; restoring the previous stack.", file=sys.stderr)
        run(base, previous, "up", "-d", "--no-build", "--remove-orphans")
        check(base, previous)
        raise
    print(json.dumps({"status": "deployed", "revision": revision, "fingerprint": fingerprint}))
    clean(candidate)


if __name__ == "__main__":
    os.umask(0o077)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    base, source, revision, fingerprint = sys.argv[1:]
    with (Path(base) / "deploy/deployment.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        deploy(Path(base), Path(source), revision, fingerprint)
