import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "network", Path(__file__).with_name("deployment-network.py")
)
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)


class NetworkTests(unittest.TestCase):
    def test_only_browser_uid_is_filtered_and_private_and_ipv6_connections_are_rejected(self):
        rules = network.rules(1234, ["8.8.4.4"])
        self.assertIn("meta skuid 1234 jump browser", rules)
        self.assertIn("ct direction reply ct state established,related accept", rules)
        self.assertIn("meta nfproto ipv6 reject", rules)
        self.assertIn("fib daddr type local reject", rules)
        for destination in (*network.PRIVATE_V4, "8.8.4.4"):
            self.assertIn(destination, rules)
        accepts = [line.strip() for line in rules.splitlines() if line.endswith("accept")]
        self.assertEqual(
            accepts,
            [
                "ct direction reply ct state established,related accept",
                "ip daddr 127.0.0.53 udp dport 53 accept",
                "ip daddr 127.0.0.53 tcp dport 53 accept",
            ],
        )
        self.assertLess(rules.index("fib daddr type local reject"), rules.index("  return"))

    def test_root_account_and_unvalidated_addresses_cannot_generate_policy(self):
        for uid in (0, -1, "1234; accept"):
            with self.assertRaises(ValueError):
                network.rules(uid, [])
        with self.assertRaises(ValueError):
            network.rules(1234, ["$(id)"])

    def test_policy_verification_rejects_tampering_uid_change_or_replaced_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "receipt.json"
            original = {"uid": 1234, "source": "hash", "policy": ["deny"]}
            with (
                patch.object(network, "RECEIPT", receipt),
                patch.object(network.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=1234)),
                patch.object(network, "signature", return_value="hash"),
                patch.object(network, "policy", return_value=["deny"]),
            ):
                receipt.write_text(json.dumps(original))
                network.verify()
                for key, value in [("uid", 1235), ("source", "changed"), ("policy", ["accept"])]:
                    receipt.write_text(json.dumps({**original, key: value}))
                    with self.assertRaises(RuntimeError):
                        network.verify()
                receipt.unlink()
                with self.assertRaises(FileNotFoundError):
                    network.verify()

    def test_failed_install_leaves_no_ready_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "receipt.json"
            public = Path(directory) / "public-url"
            public.write_text("https://workspace.example.invalid")
            read = Path.read_text

            def read_text(path, *args, **kwargs):
                return read(
                    public if str(path) == "/etc/xpathed/public-url" else path, *args, **kwargs
                )

            with (
                patch.object(network, "RECEIPT", receipt),
                patch.object(Path, "read_text", read_text),
                patch.object(network.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=1234)),
                patch.object(
                    network.socket, "gethostbyname_ex", return_value=("host", [], ["8.8.4.4"])
                ),
                patch.object(network.subprocess, "run", return_value=SimpleNamespace(returncode=0)),
                patch.object(
                    network, "command", side_effect=subprocess.CalledProcessError(1, "nft")
                ),
            ):
                with self.assertRaises(subprocess.CalledProcessError):
                    network.install()
                self.assertFalse(receipt.exists())

    def test_kernel_handles_are_ignored_but_rule_order_is_retained(self):
        value = {
            "nftables": [
                {"metainfo": {"version": "1"}},
                {"rule": {"handle": 4, "expr": ["deny"]}},
                {"rule": {"handle": 7, "expr": ["return"]}},
            ]
        }
        with patch.object(network, "command", return_value=json.dumps(value)):
            self.assertEqual(
                network.policy(), [{"rule": {"expr": ["deny"]}}, {"rule": {"expr": ["return"]}}]
            )


if __name__ == "__main__":
    unittest.main()
