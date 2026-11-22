"""Network-free eligibility regressions for bounded GitHub source-check recovery."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from uk_retry_source import retry_allowed

REPO = "phuk-prog/Drivemate-map"


def event(attempt=1, branch="main", outcome="failure", trigger="schedule"):
    return {
        "action": "completed",
        "workflow_run": {
            "name": "Publish UK map data to GitHub Releases",
            "conclusion": outcome,
            "event": trigger,
            "head_branch": branch,
            "head_repository": {"full_name": REPO},
            "id": 45009008976,
            "run_attempt": attempt,
        },
    }


class RecoverUKSourceTest(unittest.TestCase):
    def test_only_lone_source_failures_retry_up_to_three(self):
        source = [{"name": "test", "conclusion": "success"},
                  {"name": "check-source", "conclusion": "failure"},
                  {"name": "rebuild-map", "conclusion": "skipped"}]
        self.assertTrue(retry_allowed(event(1), source, REPO))
        self.assertTrue(retry_allowed(event(2), source, REPO))
        self.assertFalse(retry_allowed(event(3), source, REPO))

    def test_never_retry_other_failed_or_nonmain_jobs(self):
        failure = [{"name": "check-source", "conclusion": "failure"}]
        self.assertFalse(retry_allowed(event(branch="some-pr"), failure, REPO))
        self.assertFalse(retry_allowed(event(outcome="success"), failure, REPO))
        self.assertFalse(retry_allowed(event(trigger="pull_request"), failure, REPO))
        self.assertFalse(retry_allowed(event(), failure, "foreign/repo"))
        self.assertFalse(retry_allowed(event(), failure + [
            {"name": "test", "conclusion": "failure"}], REPO))
        self.assertFalse(retry_allowed(event(), [
            {"name": "rebuild-map / tiles", "conclusion": "failure"}], REPO))

    def test_reject_wrong_workflow_owner_and_event(self):
        x = event()
        x["workflow_run"]["head_repository"]["full_name"] = "untrusted/fork"
        self.assertFalse(retry_allowed(x, [{"name": "check-source", "conclusion": "failure"}], REPO))
        x = event()
        x["workflow_run"]["name"] = "Other workflow"
        self.assertFalse(retry_allowed(x, [{"name": "check-source", "conclusion": "failure"}], REPO))
        x = event()
        x["action"] = "requested"
        self.assertFalse(retry_allowed(x, [{"name": "check-source", "conclusion": "failure"}], REPO))


if __name__ == "__main__":
    unittest.main()
