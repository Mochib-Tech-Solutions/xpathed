import importlib.util
import io
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import re
import tempfile
import tarfile
from threading import Thread
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host = load("host", "deployment-host.py")
receiver = load("receiver", "deployment-receiver.py")
deploy = host.deploy


def without_cleanup(*args, **kwargs):
    return deploy(*args, **kwargs, clean=lambda state: None)


host.deploy = without_cleanup


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        (self.base / "deploy").mkdir()
        self.source = self.base / "source"
        self.source.mkdir()
        (self.source / "input").write_text("candidate")
        self.old = {"revision": "a" * 40, "fingerprint": "b" * 64, "source": str(self.base / "old")}
        self.state = self.base / "deploy/current.json"
        self.state.write_text(json.dumps(self.old))
        self.calls = []

    def run_compose(self, base, state, *args):
        self.calls.append((state["revision"], args))

    def deploy(self, **kwargs):
        host.deploy(self.base, self.source, "c" * 40, "d" * 64, run=self.run_compose,
                    check=lambda *args: None, **kwargs)

    def test_unchanged_does_not_build_or_restart(self):
        host.deploy(self.base, self.source, "c" * 40, "b" * 64, run=self.run_compose,
                    check=lambda base, state: self.calls.append((state["revision"], ("health",))))
        self.assertEqual(self.calls, [(self.old["revision"], ("health",))])
        self.assertEqual(json.loads(self.state.read_text()), self.old)

    def test_unhealthy_unchanged_inputs_fail_without_build_or_cleanup(self):
        def unhealthy(base, state):
            raise RuntimeError("existing deployment is unhealthy")
        with self.assertRaisesRegex(RuntimeError, "existing deployment is unhealthy"):
            deploy(self.base, self.source, "c" * 40, "b" * 64, run=self.run_compose,
                   check=unhealthy, clean=lambda state: self.calls.append(("cleanup",)))
        self.assertEqual(self.calls, [])
        self.assertEqual(json.loads(self.state.read_text()), self.old)

    def test_success_records_only_after_build_switch_and_health(self):
        def check(base, state):
            self.assertEqual(json.loads(self.state.read_text()), self.old)
            self.calls.append((state["revision"], ("health",)))
        host.deploy(self.base, self.source, "c" * 40, "d" * 64, run=self.run_compose, check=check)
        self.assertEqual([args[0] for _, args in self.calls], ["build", "up", "health"])
        self.assertEqual(json.loads(self.state.read_text())["revision"], "c" * 40)

    def test_bad_health_restores_previous_images_and_keeps_receipt(self):
        def check(base, state):
            if state["revision"] != self.old["revision"]:
                raise RuntimeError("unhealthy candidate")
        with self.assertRaisesRegex(RuntimeError, "unhealthy candidate"):
            host.deploy(self.base, self.source, "c" * 40, "d" * 64, run=self.run_compose, check=check)
        self.assertEqual(self.calls[-1], (self.old["revision"], ("up", "-d", "--no-build", "--remove-orphans")))
        self.assertEqual(json.loads(self.state.read_text()), self.old)

    def test_failed_build_never_switches(self):
        def run(*args):
            raise RuntimeError("build failed")
        with self.assertRaisesRegex(RuntimeError, "build failed"):
            host.deploy(self.base, self.source, "c" * 40, "d" * 64, run=run)
        self.assertEqual(json.loads(self.state.read_text()), self.old)

    def test_health_uses_the_web_proxy_routes_and_private_resolver(self):
        nginx = (Path(__file__).resolve().parents[1] / "docker/web/nginx.conf").read_text()
        routes = {"/", *re.findall(r"location = (\S+) \{ proxy_pass http://[^;]+/health;", nginx)}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200 if self.path in routes else 404)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            (self.base / "deploy/public-url").write_text(f"http://127.0.0.1:{server.server_port}")
            with patch.object(host, "compose", side_effect=self.run_compose):
                host.healthy(self.base, self.old)
            self.assertEqual(self.calls, [(self.old["revision"],
                ("exec", "-T", "web", "wget", "-q", "-O", "/dev/null", "http://resolver:8080/health"))])
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_receiver_rejects_other_commands_without_consuming_input(self):
        for command in ("", "id", "deploy ../bad hash", "deploy " + "a" * 40 + " " + "b" * 64 + "; id"):
            with self.assertRaises(ValueError):
                receiver.receive(self.base, command, io.BytesIO(b""))
        self.assertFalse((self.base / "incoming").exists())

    def test_receiver_rejects_archive_escape_and_cleans_incoming_files(self):
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

    def test_cleanup_keeps_active_previous_and_unrelated_images(self):
        current = {"revision": "a" * 40, "previousRevision": "b" * 40}
        references = [f"xpathed/web:{revision * 40}" for revision in ("a", "b", "c")]
        references += ["nginx:latest", "xpathed/browser:development", "other/web:" + "c" * 40]
        self.assertEqual(host.obsolete_images(references, current), {"xpathed/web:" + "c" * 40})


if __name__ == "__main__":
    unittest.main()
