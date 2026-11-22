#!/usr/bin/env python3
"""Reproducible release packaging of a native Valhalla tile extract."""
import argparse
import hashlib
import json
from pathlib import Path
import re

FORMAT = "drivemate-valhalla-routing-v1"
MAX_PART = 850_000_000
CHUNK = 2**20
IMAGE = "ghcr.io/valhalla/valhalla:3.8.3@sha256:f648b73740c36006ba5719dfc5ff30ceda1bf5152f4d7d90c214d7e4155374e4"

def sha_file(path):
    with open(path, "rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()

def package(tar_path, metadata_path, out, part_bytes=MAX_PART):
    if not isinstance(part_bytes, int) or not 1 <= part_bytes <= MAX_PART:
        raise ValueError("Invalid GitHub Release part limit")
    source = json.loads(Path(metadata_path).read_text(encoding="utf-8"))
    tag = source.get("source_release", "")
    digest = source.get("source_sha256", "")
    if not re.fullmatch(r"uk-map-\d{8}T\d{6}Z-[a-f0-9]{12}", tag):
        raise ValueError("Unpinned UK map source tag")
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("Missing source digest")
    tar = Path(tar_path)
    if not tar.is_file() or tar.stat().st_size < 1:
        raise ValueError("Missing Valhalla tile extract")
    output = Path(out)
    output.mkdir(parents=True, exist_ok=True)
    # Source-code fingerprint makes a changed builder invalidate a stale pack.
    builder = hashlib.sha256(
        Path(__file__).read_bytes()
        + Path(__file__).with_name("build_valhalla_graph.sh").read_bytes()
    ).hexdigest()
    parts = []
    total = hashlib.sha256()
    with tar.open("rb") as stream:
        index = 0
        while True:
            name = f"uk-valhalla-tiles.tar.part-{index:03d}"
            path = output / name
            size = 0
            digest_part = hashlib.sha256()
            with path.open("wb") as part:
                while size < part_bytes:
                    chunk = stream.read(min(CHUNK, part_bytes - size))
                    if not chunk:
                        break
                    part.write(chunk)
                    digest_part.update(chunk)
                    total.update(chunk)
                    size += len(chunk)
            if size == 0:
                path.unlink()
                break
            parts.append({"name": name, "bytes": size, "sha256": digest_part.hexdigest()})
            index += 1
            if index > 100:
                raise ValueError("Valhalla tile release requires too many parts")
    if not parts:
        raise ValueError("Empty Valhalla tile pack")
    if total.hexdigest() != sha_file(tar):
        raise ValueError("Valhalla tile extract changed during packaging")
    manifest = {
        "format": FORMAT, "source_tag": tag,
        "source_sha256": digest, "builder_sha256": builder,
        "valhalla_image": IMAGE,
        "tile_extract_file": "tiles.tar",
        "tile_extract_bytes": tar.stat().st_size,
        "tile_extract_sha256": total.hexdigest(),
        "parts": parts, "licence": "ODbL-1.0",
        "attribution": "© OpenStreetMap contributors",
        "engine_licence": "MIT",
        "status": "EXPERIMENTAL_NOT_ROAD_VALIDATED"
    }
    (output / "uk-valhalla-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tar", default="valhalla-output/tiles.tar")
    parser.add_argument("--source-metadata", default="cache/source-release.json")
    parser.add_argument("--output", default="valhalla-package")
    args = parser.parse_args()
    result = package(args.tar, args.source_metadata, args.output)
    print(json.dumps({"tag": result["source_tag"], "bytes": result["tile_extract_bytes"],
                      "parts": len(result["parts"])}))

if __name__ == "__main__":
    main()
