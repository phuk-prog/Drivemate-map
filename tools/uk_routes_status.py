#!/usr/bin/env python3
"""Decide if a complete routing release matches the current published UK PBF."""
import json
import os
from pathlib import Path
import subprocess
import tempfile


def needs_routes(source_tag, repo, runner=subprocess.run):
    with tempfile.TemporaryDirectory() as tmp:
        try:
            result=runner(["gh","release","download","routes-latest","--repo",repo,
                           "--pattern","uk-routing-manifest.json","--dir",tmp],
                          capture_output=True,text=True,timeout=60,check=False)
            if result.returncode != 0:
                return True
            manifest=json.loads((Path(tmp)/"uk-routing-manifest.json").read_text())
            if manifest.get("source_tag")!=source_tag or \
                    manifest.get("format")!="drivemate-uk-routing-v1":
                return True
            listing=runner(["gh","release","view","routes-latest","--repo",repo,
                            "--json","assets"],capture_output=True,text=True,
                           timeout=60,check=False)
            if listing.returncode:
                return True
            published={item["name"] for item in json.loads(listing.stdout)["assets"]}
            expected={"uk-routing-manifest.json"}|{p["name"] for p in manifest["parts"]}
            return not expected.issubset(published)
        except (OSError,ValueError,TypeError,KeyError,subprocess.TimeoutExpired):
            return True


if __name__=="__main__":
    rebuild=needs_routes(os.environ.get("SOURCE_TAG",""),os.environ.get("GH_REPO",""))
    print("UK routing rebuild needed:",rebuild)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"],"a") as output:
            output.write("needs_routes="+str(rebuild).lower()+"\n")
