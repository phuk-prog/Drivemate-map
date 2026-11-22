"""Map freshness schedule must stay explicit, idempotent and conservative.

These tests do not claim Github cron executes at exact wall-clock times, nor
that the Android app has ingested any released PMTiles.
"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/uk-map-github.yml").read_text(encoding="utf-8")
DOC = (ROOT / "docs/uk-map-data.md").read_text(encoding="utf-8")


class MapScheduleTest(unittest.TestCase):
    def test_three_checks_daily_are_unique_and_utc(self):
        scheduled = WORKFLOW.split("  schedule:", 1)[1].split("  workflow_dispatch:", 1)[0]
        crons = re.findall(r"(?m)^\s+- cron: '([^']+)'$", scheduled)
        self.assertEqual(crons, ["43 03 * * *", "43 11 * * *", "43 19 * * *"])
        self.assertEqual(len(crons), len(set(crons)))
        self.assertIn("03:43, 11:43 and 19:43 UTC", DOC)
        self.assertIn("executions can be delayed", DOC)

    def test_map_source_and_tiles_only_advance_on_valid_change(self):
        self.assertIn("cancel-in-progress: false", WORKFLOW)
        self.assertIn("needs: test", WORKFLOW)
        self.assertIn("python3 tools/uk_github_releases.py", WORKFLOW)
        self.assertIn("python3 tools/uk_tiles_status.py", WORKFLOW)
        self.assertIn("needs.check-source.outputs.needs_tiles == 'true'", WORKFLOW)
        self.assertIn("github.event_name == 'pull_request'", WORKFLOW)
        self.assertIn("tools/test_uk_schedule.py", WORKFLOW)
        self.assertIn("contents: write", WORKFLOW)


if __name__ == "__main__":
    unittest.main()
