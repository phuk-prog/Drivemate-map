#!/usr/bin/env python3
"""Fail closed before publishing a multipart UK Valhalla routing Release.

The workflow creates a GitHub draft, uploads every asset, queries GitHub's
actual asset metadata, runs this verifier, and only then publishes it.
This prevents a failed multi-GB upload from advertising an incomplete pack.
"""
import argparse
import json
from pathlib import Path
import re
import sys

MAX_PART = 850_000_000
FORMAT = "drivemate-valhalla-routing-v1"


def expected_assets(manifest, manifest_file):
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise ValueError("Unsupported routing manifest")
    if manifest.get("status") != "EXPERIMENTAL_NOT_ROAD_VALIDATED":
        raise ValueError("Unexpected Valhalla graph validation state")
    if manifest.get("licence") != "ODbL-1.0":
        raise ValueError("OSM provenance missing")
    if not re.fullmatch(r"uk-map-\d{8}T\d{6}Z-[a-f0-9]{12}",
                        str(manifest.get("source_tag", ""))):
        raise ValueError("UK source is not immutable")
    for field in ("source_sha256", "builder_sha256", "tile_extract_sha256"):
        if not re.fullmatch(r"[a-f0-9]{64}", str(manifest.get(field, ""))):
            raise ValueError("Manifest digest missing: " + field)
    parts = manifest.get("parts")
    if not isinstance(parts, list) or not 1 <= len(parts) <= 100:
        raise ValueError("Invalid routing asset count")
    expected = {Path(manifest_file).name: Path(manifest_file).stat().st_size}
    total = 0
    for index, part in enumerate(parts):
        if not isinstance(part, dict):
            raise ValueError("Invalid routing asset manifest entry")
        name = "uk-valhalla-tiles.tar.part-" + f"{index:03d}"
        if part.get("name") != name or name in expected:
            raise ValueError("Missing or out-of-order routing part")
        size = part.get("bytes")
        if not isinstance(size, int) or not 1 <= size <= MAX_PART:
            raise ValueError("Bad routing asset size")
        if not re.fullmatch(r"[a-f0-9]{64}", str(part.get("sha256", ""))):
            raise ValueError("Routing asset digest missing")
        total += size
        expected[name] = size
    if total != manifest.get("tile_extract_bytes"):
        raise ValueError("Incomplete routing manifest total")
    return expected


def verify_release(manifest_file, release):
    if not isinstance(release, dict) or not release.get("draft"):
        raise ValueError("Never verify/publish a non-draft release")
    if not release.get("prerelease"):
        raise ValueError("Unvalidated UK routing must remain a prerelease")
    manifest_file = Path(manifest_file)
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    expected = expected_assets(manifest, manifest_file)
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise ValueError("Missing GitHub asset list")
    uploaded = {}
    for asset in assets:
        if not isinstance(asset, dict):
            raise ValueError("Bad GitHub asset metadata")
        name, size = asset.get("name"), asset.get("size")
        if not isinstance(name, str) or name in uploaded or not isinstance(size, int):
            raise ValueError("Duplicate/invalid GitHub asset")
        if asset.get("state") != "uploaded":
            raise ValueError("Routing asset was not fully uploaded: " + name)
        uploaded[name] = size
    if uploaded != expected:
        raise ValueError("GitHub asset list/size mismatch. Missing or extra Release part: "
                         + repr(set(expected.items()) ^ set(uploaded.items())))
    return len(uploaded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--release-json", default="-",
                        help="GitHub API release JSON, or '-' for stdin")
    args = parser.parse_args()
    data = sys.stdin.read() if args.release_json == "-" else Path(
        args.release_json).read_text(encoding="utf-8")
    count = verify_release(args.manifest, json.loads(data))
    print("PASS: " + str(count) + " immutable draft assets verified before publication")


if __name__ == "__main__":
    main()
