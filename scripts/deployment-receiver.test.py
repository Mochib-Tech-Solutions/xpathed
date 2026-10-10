import contextlib
import importlib.util
import io
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "receiver", Path(__file__).with_name("deployment-receiver.py")
)
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


class ReceiverTests(unittest.TestCase):
    def test_success_and_failure_output_never_expose_private_addresses(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "deploy").mkdir()
            (base / "deploy/public-url").write_text("https://workspace.example.invalid\n")
            (base / "deploy/private-log-values").write_text("192.0.2.8\nserver.example.invalid\n")
            for status in (0, 1):
                output = io.StringIO()
                command = [
                    sys.executable,
                    "-c",
                    "import sys,time; "
                    "sys.stdout.write('https://work'); sys.stdout.flush(); time.sleep(.02); "
                    "print('space.example.invalid/health ready'); "
                    "print('192.0.2.8 SERVER.EXAMPLE.INVALID failed',file=sys.stderr); "
                    f"sys.exit({status})",
                ]
                with contextlib.redirect_stdout(output):
                    if status:
                        with self.assertRaisesRegex(RuntimeError, "Deployment worker failed"):
                            receiver.forward_output(base, command)
                    else:
                        receiver.forward_output(base, command)
                self.assertNotIn("workspace", output.getvalue().lower())
                self.assertNotIn("192.0.2.8", output.getvalue())
                self.assertNotIn("server.example", output.getvalue().lower())
                self.assertIn("[deployment address]/health ready", output.getvalue())
                self.assertIn("[deployment address] [deployment address] failed", output.getvalue())


if __name__ == "__main__":
    unittest.main()
