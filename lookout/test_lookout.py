import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lookout


class LookoutTests(unittest.TestCase):
    def test_extract_json_strips_leading_t3_warnings(self) -> None:
        noisy = (
            "[00:45:02.543] WARN (#20): Database migration history diverges\n"
            "  divergent: ['77:Repair']\n"
            '[{"threadId":"abc","status":"running","title":"Fix bug"}]'
        )
        parsed = lookout.extract_json_payload(noisy)
        self.assertIsInstance(parsed, list)
        self.assertEqual(parsed[0]["threadId"], "abc")

    def test_collect_ram_returns_sensible_values(self) -> None:
        total, free, pct = lookout.collect_ram_mb()
        self.assertGreater(total, 128)
        self.assertGreaterEqual(free, 0)
        self.assertLessEqual(free, total)
        self.assertGreaterEqual(pct, 0)
        self.assertLessEqual(pct, 100)

    def test_default_capabilities(self) -> None:
        self.assertIn("research", lookout.default_capabilities_for_role("vm"))
        self.assertIn("heavy", lookout.default_capabilities_for_role("workstation"))
        self.assertIn("tiny", lookout.default_capabilities_for_role("tiny"))

    def test_execute_command_blocks_option_injection_and_unlisted_projects(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            allowed = [{"title": "demo-app", "path": tmp}]
            # Rejects project outside allowed list
            res_unlisted = lookout.execute_command(
                "/bin/echo",
                {"kind": "launch_thread", "payload": {"project": "/etc", "prompt": "hi"}},
                allowed_projects=allowed,
            )
            self.assertFalse(res_unlisted["ok"])
            self.assertIn("allowed projects", res_unlisted["error"])

            # Rejects option-like threadId
            res_flag = lookout.execute_command(
                "/bin/echo",
                {"kind": "send_message", "payload": {"threadId": "--base-dir=/tmp", "message": "hi"}},
                allowed_projects=allowed,
            )
            self.assertFalse(res_flag["ok"])
            self.assertIn("must not start with '-'", res_flag["error"])


if __name__ == "__main__":
    unittest.main()
