#!/usr/bin/env python3
"""Reconstruct the latest published UK OSM PBF from verified GitHub Release parts.

This is a source map-data reader for the offline PMTiles build, not routing.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from preflight_tile_inputs import load_local_region

from uk_github_releases import (
    PART_BYTES, PBF_URL, MIN_BYTES, SyncError,
    checksum, existing_manifest, run,
)

PART_PATTERN = re.compile(r"uk\.osm\.pbf\.part-\d{3}$")


def validate_manifest(manifest):
    if manifest.get("source_url") != PBF_URL or manifest.get("licence") != "ODbL-1.0":
        raise SyncError("Unexpected source or licence in map manifest")
    parts = manifest.get("parts")
    if not isinstance(parts, list) or not 1 <= len(parts) <= 30:
        raise SyncError("Invalid UK map parts list")
    if not isinstance(manifest.get("bytes"), int) or manifest["bytes"] < MIN_BYTES:
        raise SyncError("Invalid whole-map size")
    if not re.fullmatch(r"[a-f0-9]{64}", manifest.get("sha256", "")):
        raise SyncError("Invalid whole-map SHA-256")
    for index, part in enumerate(parts):
        if not isinstance(part, dict) or part.get("name") != f"uk.osm.pbf.part-{index:03}":
            raise SyncError("Unexpected part name, order or path")
        if not PART_PATTERN.fullmatch(part["name"]):
            raise SyncError("Unexpected part filename")
        if not isinstance(part.get("bytes"), int) or not 0 < part["bytes"] <= PART_BYTES:
            raise SyncError("Part size is invalid")
        if not re.fullmatch(r"[a-f0-9]{64}", part.get("sha256", "")):
            raise SyncError("Invalid part SHA-256")
    if sum(part["bytes"] for part in parts) != manifest["bytes"]:
        raise SyncError("Sum of part sizes differs from published full-map size")
    return parts


def reconstruct(manifest, folder, output):
    parts = validate_manifest(manifest)
    actual = {p.name for p in Path(folder).iterdir() if p.name.startswith("uk.osm.pbf.part-")}
    expected = {p["name"] for p in parts}
    if actual != expected:
        raise SyncError(f"Missing or extra UK map parts: {sorted(expected ^ actual)}")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".staged")
    try:
        whole = hashlib.sha256()
        total = 0
        with temporary.open("wb") as destination:
            for part in parts:
                source = Path(folder) / part["name"]
                if source.stat().st_size != part["bytes"]:
                    raise SyncError("Incorrect part byte length: " + part["name"])
                if checksum(source) != part["sha256"]:
                    raise SyncError("Incorrect part SHA-256: " + part["name"])
                with source.open("rb") as handle:
                    for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
                        whole.update(block)
                        destination.write(block)
                        total += len(block)
        if total != manifest["bytes"] or whole.hexdigest() != manifest["sha256"]:
            raise SyncError("Complete UK map SHA-256 mismatch")
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def use_bundled_polygon(path):
    """Use version-controlled Geofabrik UK clipping polygon validated in preflight."""
    _, source = load_local_region("united-kingdom")
    shutil.copyfile(source, path)



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dest", type=Path, default=Path("cache"))
    parser.add_argument("--source-tag", help="Restore an exact immutable source rather than the latest")
    parser.add_argument("--source-sha256", help="Require this digest (e.g. the installed routing graph source)")
    args = parser.parse_args()
    repo = os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY")
    if not repo or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise SyncError("Missing/invalid GitHub repository")
    if not os.environ.get("GH_TOKEN") or not shutil.which("gh"):
        raise SyncError("Authenticated GitHub CLI is required")
    args.dest.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="uk-map-parts-", dir=args.dest) as name:
        temp = Path(name)
        if args.source_tag:
            if not re.fullmatch(r"uk-map-\d{8}T\d{6}Z-[a-f0-9]{12}",args.source_tag):
                raise SyncError("Invalid immutable source tag")
            release=json.loads(run(["gh","release","view",args.source_tag,"--repo",repo,"--json","isDraft,tagName"]))
            if release.get("isDraft") or release.get("tagName")!=args.source_tag:
                raise SyncError("Source release is not published")
            run(["gh","release","download",args.source_tag,"--repo",repo,"--pattern","manifest.json","--dir",str(temp)])
            manifest=json.loads((temp/"manifest.json").read_text())
            if manifest.get("tag")!=args.source_tag:raise SyncError("Source tag mismatch")
        else:
            manifest = existing_manifest(repo, temp)
        if manifest is None:
            raise SyncError("No published UK map source release exists")
        validate_manifest(manifest)
        if args.source_sha256 and manifest.get("sha256")!=args.source_sha256:
            raise SyncError("Requested graph/source digest mismatch")
        run(["gh", "release", "download", manifest["tag"], "--repo", repo,
             "--pattern", "uk.osm.pbf.part-*", "--dir", str(temp)])
        reconstruct(manifest, temp, args.dest / "united-kingdom.osm.pbf")
        use_bundled_polygon(args.dest / "united-kingdom.poly")
        (args.dest / "source-release.json").write_text(json.dumps({
            "source_release": manifest["tag"],
            "source_sha256": manifest["sha256"],
            "source_replication_timestamp": manifest.get("source_replication_timestamp"),
        }, indent=2) + "\n", encoding="utf8")
        print("Restored verified UK map", manifest["tag"], manifest["sha256"], flush=True)


if __name__ == "__main__":
    try:
        main()
    except (SyncError, OSError) as exc:
        print("UK map restoration FAILED:", exc, file=sys.stderr)
        sys.exit(2)
