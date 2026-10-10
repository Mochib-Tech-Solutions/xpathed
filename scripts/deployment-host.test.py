import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host = load("host", "deployment-host.py")
receiver = load("receiver", "deployment-receiver.py")


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        (self.base / "deploy").mkdir()
        self.source = self.base / "source"
        self.source.mkdir()
        (self.source / "input").write_text("candidate")
        self.old = {"revision": "a" * 40, "fingerprint": "b" * 64, "runtime": "native"}
        self.state = self.base / "deploy/current.json"
        self.state.write_text(json.dumps(self.old))
        self.calls = []

    def operate(self, base, state, action):
        self.calls.append((state["revision"], action))

    def deploy(self, **kwargs):
        options = {"run": self.operate, "check": lambda *args: None, "clean": lambda *args: None}
        options.update(kwargs)
        host.deploy(self.base, self.source, "c" * 40, "d" * 64, **options)

    def test_unchanged_inputs_check_health_without_build_or_restart(self):
        host.deploy(
            self.base,
            self.source,
            "c" * 40,
            "b" * 64,
            run=self.operate,
            check=lambda base, state: self.calls.append((state["revision"], "health")),
        )
        self.assertEqual(self.calls, [(self.old["revision"], "health")])
        self.assertEqual(json.loads(self.state.read_text()), self.old)

    def test_success_records_only_after_build_switch_and_health_and_keeps_recovery(self):
        def check(base, state):
            self.assertEqual(json.loads(self.state.read_text()), self.old)
            self.calls.append((state["revision"], "health"))

        def clean(base, current, previous):
            self.assertEqual(json.loads(self.state.read_text()), current)
            self.assertEqual(previous, self.old)
            self.calls.append((current["revision"], "clean"))

        self.deploy(check=check, clean=clean)
        self.assertEqual(
            [action for _, action in self.calls], ["build", "switch", "health", "clean"]
        )
        self.assertEqual(json.loads((self.base / "deploy/previous.json").read_text()), self.old)

    def test_bad_health_restores_previous_release_and_keeps_receipt(self):
        def check(base, state):
            if state["revision"] != self.old["revision"]:
                raise RuntimeError("unhealthy candidate")

        with self.assertRaisesRegex(RuntimeError, "unhealthy"):
            self.deploy(
                check=check,
                clean=lambda *args: self.fail("Failed releases must not clean recovery"),
            )
        self.assertEqual(self.calls[-1], (self.old["revision"], "switch"))
        self.assertEqual(json.loads(self.state.read_text()), self.old)

    def test_failed_build_never_switches_or_changes_receipt(self):
        with self.assertRaisesRegex(RuntimeError, "build failed"):
            self.deploy(run=lambda *args: (_ for _ in ()).throw(RuntimeError("build failed")))
        self.assertEqual(json.loads(self.state.read_text()), self.old)

    def test_first_deployment_stops_failed_services_and_leaves_no_success_receipt(self):
        self.state.unlink()
        with self.assertRaisesRegex(RuntimeError, "unhealthy"):
            self.deploy(check=lambda *args: (_ for _ in ()).throw(RuntimeError("unhealthy")))
        self.assertEqual(self.calls[-1], ("c" * 40, "stop"))
        self.assertFalse(self.state.exists())

    def test_cleanup_failure_keeps_healthy_deployment(self):
        self.deploy(clean=lambda *args: (_ for _ in ()).throw(OSError("cleanup failed")))
        self.assertEqual(json.loads(self.state.read_text())["revision"], "c" * 40)
        self.assertEqual([action for _, action in self.calls], ["build", "switch"])

    def test_legacy_host_and_bad_revision_are_rejected_before_mutation(self):
        self.state.write_text(json.dumps({**self.old, "runtime": "legacy"}))
        with self.assertRaisesRegex(RuntimeError, "migrate"):
            self.deploy()
        with self.assertRaises(ValueError):
            host.deploy(self.base, self.source, "../outside", "d" * 64)
        self.assertEqual(self.calls, [])

    def test_cleanup_retains_two_releases_and_preserves_unrelated_paths(self):
        runtime = self.base / "runtime"
        (runtime / "releases").mkdir(parents=True)
        for name in ("a" * 40, "c" * 40, "d" * 40, "unrelated"):
            (runtime / "releases" / name).mkdir()
        (self.base / "deployments").mkdir()
        (self.base / "deployments" / ("a" * 40)).mkdir()
        (self.base / "deployments/unrelated").mkdir()
        removed = []
        with (
            patch.object(host, "RUNTIME", runtime),
            patch.object(host, "command", side_effect=lambda *args: removed.append(args[-1])),
        ):
            host.cleanup(self.base, {"revision": "c" * 40}, self.old)
        self.assertEqual(removed, [str(runtime / "releases" / ("d" * 40))])
        self.assertEqual([p.name for p in (self.base / "deployments").iterdir()], ["unrelated"])

    def test_switch_allows_only_the_exact_release_binary_and_supports_legacy_rollback(self):
        runtime = self.base / "runtime"
        release = runtime / "releases" / ("c" * 40)
        (release / "hosted").mkdir(parents=True)
        template = Path(__file__).parent.parent / "hosted/xpathed-headless-shell"
        (release / "hosted/xpathed-headless-shell").write_text(template.read_text())
        commands = []
        profiles = []

        def command(*args, **kwargs):
            commands.append(args)
            if args[-1] == "/etc/apparmor.d/xpathed-headless-shell" and "install" in args:
                profiles.append(Path(args[-2]).read_text())

        with (
            patch.object(host, "RUNTIME", runtime),
            patch.object(host, "command", side_effect=command),
        ):
            host.native(self.base, {"revision": "c" * 40}, "switch")
            host.native(self.base, self.old, "switch")
        self.assertEqual(len(profiles), 1)
        self.assertIn(str(release / "chromium/chrome-headless-shell"), profiles[0])
        self.assertNotIn("/opt/xpathed/current", profiles[0])
        self.assertNotIn("*", profiles[0])
        load = next(index for index, args in enumerate(commands) if "apparmor_parser" in args)
        restart = next(index for index, args in enumerate(commands) if "restart" in args)
        self.assertLess(load, restart)

    def test_receiver_rejects_commands_without_consuming_input(self):
        for command in (
            "",
            "id",
            "deploy ../bad hash",
            "deploy " + "a" * 40 + " " + "b" * 64 + "; id",
        ):
            with self.assertRaises(ValueError):
                receiver.receive(self.base, command, io.BytesIO(b""))
        self.assertFalse((self.base / "incoming").exists())

    def test_receiver_rejects_archive_escape_and_removes_incoming_files(self):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            entry = tarfile.TarInfo("../../escaped")
            entry.size = 1
            archive.addfile(entry, io.BytesIO(b"x"))
        stream.seek(0)
        with self.assertRaises(tarfile.FilterError):
            receiver.receive(self.base, "deploy " + "a" * 40 + " " + "b" * 64, stream)
        self.assertFalse((self.base / "escaped").exists())
        self.assertEqual(list((self.base / "incoming").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
