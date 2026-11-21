#!/usr/bin/env python3
"""Deterministically pin all ODbL source, request and derived files."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def snapshot(root=ROOT):
    files = {}
    for dirname, pattern in (("requests", "*.json"), ("osm", "*"), ("derived", "*"), ("pilot", "*")):
        for p in sorted((root / dirname).glob(pattern)):
            if not p.is_file():
                continue
            data = p.read_bytes()
            files[str(p.relative_to(root))] = {
                "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()
            }
    if not files:
        raise ValueError("Empty ODbL source manifest")
    return {
        "attribution": "(c) OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright",
        "files": dict(sorted(files.items())),
        "licence": "ODbL-1.0",
    }


if __name__ == "__main__":
    print(json.dumps(snapshot(), indent=2, sort_keys=True))
