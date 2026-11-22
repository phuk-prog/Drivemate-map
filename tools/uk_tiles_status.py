#!/usr/bin/env python3
"""Determine whether the most recent published UK source has matching map tiles.

The workflow calls this after each source check, *including no-change checks*.
If an earlier tile build failed, the next scheduled check will retry it,
without creating another 2.3 GB source release.

Only the live-branch catalog (written after successful publication) is treated
as the committed pointer. Verify both the dated Release and tiles-latest assets.
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys

from map_build_fingerprint import fingerprint as builder_fingerprint

SOURCE_TAG = re.compile(r"^uk-map-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$")
TILE_TAG = re.compile(r"^tiles-[0-9]{8}T[0-9]{4}Z$")
REQUIRED = {"england.pmtiles", "scotland.pmtiles", "wales.pmtiles",
            "northern-ireland.pmtiles", "catalog.json", "build-report.json"}


class StatusError(RuntimeError):
    pass


def gh(args, absent_ok=False):
    process = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
    if process.returncode:
        missing = any(x in process.stderr for x in ("404", "Not Found", "no release found"))
        if absent_ok and missing:
            return None
        raise StatusError(f"GitHub read failed: {process.stderr[-1000:]}")
    return process.stdout


def get_live_json(repo, path):
    data = gh(["api", f"repos/{repo}/contents/tiles/{path}?ref=live", "--jq", ".content"],
              absent_ok=True)
    if data is None:
        return None
    try:
        decoded = base64.b64decode(data.strip(), validate=False).decode("utf8")
        return json.loads(decoded)
    except (ValueError, UnicodeDecodeError) as exc:
        raise StatusError(f"Invalid live-branch {path}") from exc


def assets_for(repo, tag, absent_ok=False):
    raw = gh(["release", "view", tag, "--repo", repo, "--json",
              "assets,isDraft"], absent_ok=absent_ok)
    if raw is None:
        return None
    try:
        result = json.loads(raw)
        if result["isDraft"]:
            return None
        assets = result["assets"]
        return {entry["name"]: entry["size"] for entry in assets}
    except (ValueError, KeyError, TypeError) as exc:
        raise StatusError("Invalid GitHub Release asset response") from exc


def is_current(repo, source_tag):
    if not SOURCE_TAG.fullmatch(source_tag):
        raise StatusError("Invalid source tag")
    report = get_live_json(repo, "build-report.json")
    catalog = get_live_json(repo, "catalog.json")
    if report is None or catalog is None:
        return False, "Missing live branch catalog/build report"
    if report.get("source_release") != source_tag:
        return False, "Latest published tiles do not match current UK map source"
    if report.get("builder_fingerprint") != builder_fingerprint():
        return False, "Tile build recipe changed or published report lacks a recipe fingerprint"
    tag = catalog.get("release", "")
    if not isinstance(tag, str) or not TILE_TAG.fullmatch(tag):
        return False, "Latest tile catalog has no valid dated Release"
    required = set(REQUIRED)
    for entry in catalog.get("tilesets", []):
        if not isinstance(entry, dict) or not isinstance(entry.get("file"), str):
            return False, "Invalid tileset catalog"
        required.add(entry["file"])
    dated = assets_for(repo, tag, absent_ok=True)
    current = assets_for(repo, "tiles-latest", absent_ok=True)
    for name in required:
        if dated is None or name not in dated or dated[name] <= 0:
            return False, f"Dated tile release missing asset: {name}"
        if current is None or current.get(name) != dated[name]:
            return False, f"Compatibility tiles-latest asset differs: {name}"
    return True, f"Tiles ready from {tag} for UK source {source_tag}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-tag", required=True)
    parser.add_argument("--repo", default=os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY"))
    args = parser.parse_args()
    if not args.repo or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        raise StatusError("Missing or invalid repository")
    current, reason = is_current(args.repo, args.source_tag)
    needs = not current
    print(("Map tiles already current: " if current else "Map tiles need rebuild: ") + reason,
          flush=True)
    if output_path := os.environ.get("GITHUB_OUTPUT"):
        with open(output_path, "a", encoding="utf8") as stream:
            stream.write("needs_tiles=" + ("true" if needs else "false") + "\n")


if __name__ == "__main__":
    try:
        main()
    except (StatusError, OSError) as exc:
        print("UK tile freshness check failed:", exc, file=sys.stderr)
        sys.exit(2)
