import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("security", Path(__file__).with_name("hosted-security-check.py"))
security = importlib.util.module_from_spec(spec)
spec.loader.exec_module(security)


class ProbeTests(unittest.TestCase):
    def test_quota_gateway_timeout_or_success_cannot_certify_private_network_isolation(self):
        for status, body in [(429, b'{"code":"request_rate_limited"}'),
                             (502, b"gateway unavailable"),
                             (504, b'{"code":"navigation_timeout"}'),
                             (200, b'{"code":"browser_operation_failed"}'),
                             (502, b"[]")]:
            self.assertFalse(security.private_navigation_rejected((status, {}, body)))
        self.assertTrue(security.private_navigation_rejected((502, {}, b'{"code":"browser_operation_failed"}')))


if __name__ == "__main__":
    unittest.main()
