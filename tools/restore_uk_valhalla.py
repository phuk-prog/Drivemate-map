#!/usr/bin/env python3
"""Assemble only a fully SHA-256-verified UK Valhalla graph Release.

Downloads are explicitly separate from verification. This installer will not
publish or serve an incomplete graph, accept surprise assets, or overwrite a
previously installed good graph with corrupt parts.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys

FORMAT = "drivemate-valhalla-routing-v1"
STATUS = "EXPERIMENTAL_NOT_ROAD_VALIDATED"
MAX_PART = 850_000_000
IMAGE = ("ghcr.io/valhalla/valhalla:3.8.3@sha256:"
         "f648b73740c36006ba5719dfc5ff30ceda1bf5152f4d7d90c214d7e4155374e4")


def valid_sha(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def inspect_manifest(doc):
    if doc.get("format") != FORMAT or doc.get("licence") != "ODbL-1.0" or \
            doc.get("status") != STATUS or doc.get("valhalla_image") != IMAGE:
        raise ValueError("Wrong UK graph format, status, licence or pinned Valhalla engine")
    if not re.fullmatch(r"uk-map-\d{8}T\d{6}Z-[0-9a-f]{12}", doc.get("source_tag", "")):
        raise ValueError("Graph source is not an immutable UK snapshot")
    for field in ("source_sha256", "builder_sha256", "tile_extract_sha256"):
        if not valid_sha(doc.get(field)):
            raise ValueError("Missing graph SHA256: " + field)
    total = doc.get("tile_extract_bytes")
    if not isinstance(total, int) or total < 1024 or \
            doc.get("tile_extract_file") != "tiles.tar":
        raise ValueError("Invalid graph archive size/name")
    parts = doc.get("parts")
    if not isinstance(parts, list) or not 1 <= len(parts) <= 100:
        raise ValueError("Invalid release part count")
    summed = 0
    for i, part in enumerate(parts):
        if not isinstance(part, dict) or \
                part.get("name") != f"uk-valhalla-tiles.tar.part-{i:03d}" or \
                not isinstance(part.get("bytes"), int) or \
                not 0 < part["bytes"] <= MAX_PART or \
                not valid_sha(part.get("sha256")):
            raise ValueError("Invalid, reordered or unverified graph part")
        summed += part["bytes"]
    if summed != total:
        raise ValueError("UK graph parts do not match expected tar length")
    return parts


def sha_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for piece in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(piece)
    return digest.hexdigest()


def restore(manifest, parts_dir, target):
    parts = inspect_manifest(manifest)
    root = Path(parts_dir)
    expected = {x["name"] for x in parts}
    actual = {x.name for x in root.glob("uk-valhalla-tiles.tar.part-*")}
    if expected != actual:
        raise ValueError("Unexpected/missing UK Valhalla parts: " + repr(expected ^ actual))
    dest = Path(target)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        if dest.stat().st_size == manifest["tile_extract_bytes"] and \
                sha_file(dest) == manifest["tile_extract_sha256"]:
            return dest.stat().st_size  # Repeatable setup: existing verified graph is fine.
        raise ValueError("Existing graph differs; do not overwrite running server data")
    if shutil.disk_usage(dest.parent).free < manifest["tile_extract_bytes"] + 256_000_000:
        raise ValueError("Insufficient free disk for full UK Valhalla archive")
    staging = dest.with_name(dest.name + ".incomplete")
    staging.unlink(missing_ok=True)
    total, whole = 0, hashlib.sha256()
    try:
        with staging.open("wb") as output:
            for part in parts:
                path = root / part["name"]
                if not path.is_file() or path.stat().st_size != part["bytes"]:
                    raise ValueError("Missing/short UK routing asset " + part["name"])
                local = hashlib.sha256()
                with path.open("rb") as reader:
                    for chunk in iter(lambda: reader.read(8 * 1024 * 1024), b""):
                        local.update(chunk)
                        whole.update(chunk)
                        output.write(chunk)
                        total += len(chunk)
                        if total > manifest["tile_extract_bytes"]:
                            raise ValueError("Graph exceeded manifest length")
                if local.hexdigest() != part["sha256"]:
                    raise ValueError("Corrupt UK graph asset " + part["name"])
            output.flush()
        if total != manifest["tile_extract_bytes"] or \
                whole.hexdigest() != manifest["tile_extract_sha256"]:
            raise ValueError("UK Valhalla archive SHA256 mismatch")
        staging.chmod(0o444)
        staging.replace(dest)
    finally:
        staging.unlink(missing_ok=True)
    return total


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--parts", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    args = parser.parse_args(argv)
    doc = json.loads(args.manifest.read_text(encoding="utf-8"))
    print("Verified UK Valhalla archive:", restore(doc, args.parts, args.target),
          "bytes; NOT ROAD VALIDATED")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as error:
        print("FAIL UK Valhalla graph restore:", error, file=sys.stderr)
        sys.exit(2)
