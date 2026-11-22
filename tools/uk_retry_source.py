#!/usr/bin/env python3
"""Bounded default-branch recovery for one failed map source-check job."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def retry_allowed(event, jobs, repository):
    workflow = event.get("workflow_run", {})
    origin = workflow.get("head_repository") or {}
    if (not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository or "")
            or event.get("action") != "completed"
            or workflow.get("name") != "Publish UK map data to GitHub Releases"
            or workflow.get("conclusion") != "failure"
            or workflow.get("event") not in ("schedule", "push", "workflow_dispatch")
            or workflow.get("head_branch") != "main"
            or origin.get("full_name") != repository
            or not isinstance(workflow.get("id"), int)
            or not isinstance(workflow.get("run_attempt"), int)
            or not (1 <= workflow["run_attempt"] < 3)):
        return False
    # In particular, do not repeat failed tests, a partial tile release, or a PR.
    failed = [j["name"] for j in jobs if j.get("conclusion") == "failure"]
    return failed == ["check-source"]


def main():
    repository = os.environ["GH_REPO"]
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    workflow = event.get("workflow_run", {})
    if workflow.get("head_branch") != "main" or workflow.get("conclusion") != "failure":
        print("Not a failed main-branch UK source check; no retry")
        return
    run_id = workflow.get("id")
    if not isinstance(run_id, int) or run_id <= 0:
        raise ValueError("Invalid run id")
    result = subprocess.run(
        ["gh", "api", f"repos/{repository}/actions/runs/{run_id}/jobs?per_page=100&filter=latest"],
        capture_output=True, text=True, check=True)
    jobs = json.loads(result.stdout)["jobs"]
    if not retry_allowed(event, jobs, repository):
        print("Retry not permitted by exact job/workflow/attempt guard")
        return
    print(f"Retrying only the UK map source job (attempt {workflow['run_attempt'] + 1}/3)",
          flush=True)
    subprocess.run(["gh", "api", "-X", "POST",
                    f"repos/{repository}/actions/runs/{run_id}/rerun-failed-jobs"],
                   check=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as exc:
        print("UK map auto-recovery failed visibly:", exc, file=sys.stderr)
        sys.exit(2)
