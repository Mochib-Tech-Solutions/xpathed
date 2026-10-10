"""Stage the official headless shell matching the host's maintained Chrome package."""

import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path


def install(destination):
    installed = subprocess.check_output(["/opt/google/chrome/chrome", "--version"], text=True)
    version = re.fullmatch(r"Google Chrome (\d+\.\d+\.\d+\.\d+)\s*", installed)
    if not version:
        raise RuntimeError("Cannot identify the maintained Chrome version")
    url = (
        "https://storage.googleapis.com/chrome-for-testing-public/"
        + version[1]
        + "/linux64/chrome-headless-shell-linux64.zip"
    )
    with tempfile.TemporaryDirectory(prefix="xpathed-chromium-") as directory:
        temporary = Path(directory)
        archive = temporary / "shell.zip"
        with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
        with zipfile.ZipFile(archive) as bundle:
            for entry in bundle.infolist():
                path = Path(entry.filename)
                if (
                    path.is_absolute()
                    or ".." in path.parts
                    or path.parts[0] != "chrome-headless-shell-linux64"
                ):
                    raise ValueError("Unexpected headless shell archive path")
            bundle.extractall(temporary)
        source = temporary / "chrome-headless-shell-linux64"
        executable = source / "chrome-headless-shell"
        if not executable.is_file():
            raise RuntimeError("Headless shell executable is missing")
        for path in source.rglob("*"):
            path.chmod(0o755 if path.is_dir() or path.name == executable.name else 0o644)
        shutil.copytree(source, destination)
    print("Staged sandboxed headless Chromium " + version[1], file=sys.stderr)


if __name__ == "__main__":
    install(Path(sys.argv[1]))
