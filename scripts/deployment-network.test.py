import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("network", Path(__file__).with_name("deployment-network.py"))
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)
TOKEN = "aabbccdd-0011-2233-4455-66778899aabb"


class NetworkTests(unittest.TestCase):
    def test_iproute_empty_address_entries_and_ipv6_do_not_break_startup(self):
        value = '[{"addr_info":[{}, {"family":"inet6","local":"::1"}, {"family":"inet","local":"8.8.8.8"}]}]'
        with patch.object(network, "command", return_value=value):
            self.assertEqual(network.host_addresses(), ["8.8.8.8"])

    def test_failed_ipv6_or_ipv4_filter_never_releases_browser_startup(self):
        for failed in ("iptables-restore", "ip6tables-restore"):
            calls = []

            def namespace(pid, *arguments, **kwargs):
                calls.append(arguments)
                if arguments[0] == failed:
                    raise subprocess.CalledProcessError(1, arguments)
                return ""

            with (patch.object(network, "browser", return_value=("container", 42)),
                  patch.object(network, "nonce", return_value=TOKEN),
                  patch.object(network, "host_addresses", return_value=[]),
                  patch.object(network, "namespace", side_effect=namespace),
                  patch.object(network, "command") as command):
                with self.assertRaises(subprocess.CalledProcessError):
                    network.reconcile()
                command.assert_not_called()

    def test_container_replacement_cannot_release_unprotected_replacement(self):
        with (patch.object(network, "browser", side_effect=[("old", 42), ("new", 43)]),
              patch.object(network, "nonce", return_value=TOKEN),
              patch.object(network, "host_addresses", return_value=[]),
              patch.object(network, "install"), patch.object(network, "verify_policy"),
              patch.object(network, "command") as command):
            with self.assertRaisesRegex(RuntimeError, "changed"):
                network.reconcile()
            command.assert_not_called()

    def test_restart_requires_fresh_nonce_and_reinstalls_before_acknowledgement(self):
        events = []
        with (patch.object(network, "browser", return_value=("same-container", 43)),
              patch.object(network, "nonce", return_value=TOKEN),
              patch.object(network, "host_addresses", return_value=[]),
              patch.object(network, "install", side_effect=lambda *args: events.append("filter")),
              patch.object(network, "verify_policy", side_effect=lambda *args: events.append("verify")),
              patch.object(network, "command", side_effect=lambda *args: events.append("release"))):
            result = network.reconcile(("same-container", 42, "old-token"))
        self.assertEqual(events, ["filter", "verify", "release"])
        self.assertEqual(result, ("same-container", 43, TOKEN))

    def test_stale_marker_or_changed_container_fails_deployment_health(self):
        with (patch.object(network, "browser", return_value=("container", 42)),
              patch.object(network, "verify_policy"),
              patch.object(network, "host_addresses", return_value=[]),
              patch.object(network, "nonce", side_effect=[TOKEN, "old-token"])):
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                network.verify()

    def test_invalid_or_oversized_nonce_is_not_interpreted_as_command(self):
        for value in ("", "../secret", "$(id)", TOKEN + "x", "a" * 65):
            with patch.object(network, "command", return_value=value):
                with self.assertRaises(RuntimeError):
                    network.nonce("container", "wait")

    def test_host_ip_validation_rejects_command_text(self):
        with patch.object(network, "command", return_value='[{"addr_info":[{"family":"inet","local":"$(id)"}]}]'):
            with self.assertRaises(ValueError):
                network.host_addresses()


if __name__ == "__main__":
    unittest.main()
