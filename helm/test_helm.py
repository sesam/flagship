import io
import json
import contextlib
import unittest
from unittest import mock
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import helm


class HelmTests(unittest.TestCase):
    def test_print_overview_renders_executive_sections(self) -> None:
        sample = {
            "standDown": False,
            "standDownReason": None,
            "counts": {
                "nodesOnline": 2,
                "nodesTotal": 2,
                "threadsActive": 1,
                "needsAttention": 1,
                "ideasInbox": 1,
            },
            "nodes": [
                {
                    "nodeId": "cloud-vm",
                    "name": "Cloud VM",
                    "role": "vm",
                    "status": "online",
                    "telemetry": {
                        "ramFreeMb": 8100,
                        "ramTotalMb": 16000,
                        "load1m": 0.5,
                        "cpuCores": 4,
                        "activeThreads": 1,
                        "maxSlots": 6,
                        "devices": [],
                    },
                }
            ],
            "needsAttention": [
                {
                    "nodeId": "cloud-vm",
                    "title": "Waiting PR check",
                    "status": "waiting",
                    "stalled": False,
                    "link": "https://app.t3.codes/threads/env/1",
                }
            ],
            "inFlight": [
                {
                    "nodeId": "cloud-vm",
                    "title": "Research pricing",
                    "status": "running",
                    "link": "https://app.t3.codes/threads/env/2",
                }
            ],
            "rebalanceSuggestions": [
                {"severity": "warn", "message": "Shift heavy build to Dev Laptop"}
            ],
            "ideas": [
                {
                    "id": "idea_123",
                    "title": "Add Android tablet CI",
                    "priority": "P1",
                    "status": "inbox",
                    "workload": "mobile",
                    "project": "web-app",
                }
            ],
        }
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            helm.print_overview(sample)
        rendered = buf.getvalue()
        self.assertIn("FLAGSHIP OVERVIEW [ACTIVE]", rendered)
        self.assertIn("Cloud VM", rendered)
        self.assertIn("Needs Attention", rendered)
        self.assertIn("Rebalance / Efficiency Suggestions", rendered)
        self.assertIn("idea_123", rendered)

    def test_webhook_set_sends_thread_id(self) -> None:
        calls: list[tuple[str, str, dict]] = []

        def fake_api(hub: str, token: str, path: str, method: str = "GET", payload=None):
            calls.append((path, method, payload))
            return {"ok": True, "configured": True, "helmThreadId": payload.get("threadId")}

        buf = io.StringIO()
        with mock.patch.object(helm, "load_auth", return_value=("https://hub.test", "tok")), \
             mock.patch.object(helm, "api", side_effect=fake_api), \
             contextlib.redirect_stdout(buf):
            helm.main(["webhook", "set", "https://t3.test/wh", "--thread-id", "th_home_123"])

        self.assertEqual(
            calls,
            [("/api/control/webhook", "POST", {"url": "https://t3.test/wh", "secret": "", "threadId": "th_home_123"})],
        )
        out = json.loads(buf.getvalue())
        self.assertEqual(out["helmThreadId"], "th_home_123")

    def test_dismiss_single_and_all_failed(self) -> None:
        calls: list[tuple[str, str, dict]] = []

        def fake_api(hub: str, token: str, path: str, method: str = "GET", payload=None):
            calls.append((path, method, payload))
            return {"ok": True, "dismissedCount": 1}

        buf = io.StringIO()
        with mock.patch.object(helm, "load_auth", return_value=("https://hub.test", "tok")), \
             mock.patch.object(helm, "api", side_effect=fake_api), \
             contextlib.redirect_stdout(buf):
            helm.main(["dismiss", "th_old_fail"])
            helm.main(["dismiss", "--all-failed"])

        self.assertEqual(
            calls,
            [
                ("/api/threads/dismiss", "POST", {"threadId": "th_old_fail"}),
                ("/api/threads/dismiss", "POST", {"allFailed": True}),
            ],
        )

    def test_dismiss_requires_target_or_flag(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as ctx:
            helm.main(["dismiss"])
        self.assertEqual(ctx.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
