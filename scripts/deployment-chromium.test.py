import importlib.util
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "chromium", Path(__file__).with_name("deployment-chromium.py")
)
chromium = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chromium)


class ChromiumTests(unittest.TestCase):
    def archive(self, filename="chrome-headless-shell-linux64/chrome-headless-shell"):
        result = io.BytesIO()
        with zipfile.ZipFile(result, "w") as bundle:
            bundle.writestr(filename, "browser")
            bundle.writestr("chrome-headless-shell-linux64/icudtl.dat", "data")
        result.seek(0)
        return result

    def test_installs_matching_official_shell_without_writable_or_setuid_files(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                chromium.subprocess, "check_output", return_value="Google Chrome 155.0.8059.39\n"
            ),
            patch.object(
                chromium.urllib.request, "urlopen", return_value=self.archive()
            ) as download,
        ):
            destination = Path(directory) / "chromium"
            chromium.install(destination)
            download.assert_called_once_with(
                "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.39/linux64/chrome-headless-shell-linux64.zip",
                timeout=120,
            )
            self.assertEqual((destination / "chrome-headless-shell").stat().st_mode & 0o7777, 0o755)
            self.assertEqual((destination / "icudtl.dat").stat().st_mode & 0o7777, 0o644)

    def test_rejects_unrecognized_versions_before_downloading(self):
        with (
            patch.object(chromium.subprocess, "check_output", return_value="unrecognized"),
            patch.object(chromium.urllib.request, "urlopen") as download,
        ):
            with self.assertRaises(RuntimeError):
                chromium.install(Path("unused"))
            download.assert_not_called()

    def test_rejects_archive_escape_and_missing_executable_before_installing(self):
        for filename in ("../escaped", "chrome-headless-shell-linux64/only-data"):
            with (
                tempfile.TemporaryDirectory() as directory,
                patch.object(
                    chromium.subprocess,
                    "check_output",
                    return_value="Google Chrome 155.0.8059.39\n",
                ),
                patch.object(
                    chromium.urllib.request, "urlopen", return_value=self.archive(filename)
                ),
            ):
                destination = Path(directory) / "chromium"
                with self.assertRaises((ValueError, RuntimeError)):
                    chromium.install(destination)
                self.assertFalse(destination.exists())
                self.assertFalse((Path(directory) / "escaped").exists())


if __name__ == "__main__":
    unittest.main()
