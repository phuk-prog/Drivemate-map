#!/usr/bin/env python3
"""Cut the UK vector tiles into downloadable map area packs and write the manifest.

CI only (called by build-map-packs.yml). Each pack is a `pmtiles extract` of the UK tiles for a
bounding box (optionally limited to a maximum zoom). The manifest `map-packs.json` lists every
pack with its size, SHA-256, version and download URLs; the DriveMate app reads that manifest,
downloads whole packs once, verifies them, and checks the manifest for updates.

Map data (c) OpenStreetMap contributors, ODbL 1.0.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
MAX_PACK_BYTES = 1_900_000_000      # GitHub allows < 2 GiB per release file
MIN_PACK_BYTES = 10_000
LON_RANGE = (-11.0, 3.0)
LAT_RANGE = (49.0, 61.5)
MAX_ZOOM = 14
SCHEMA = 1


class RegionError(ValueError):
    pass


def load_regions(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    regions = data.get("regions")
    if not isinstance(regions, list) or not 1 <= len(regions) <= 64:
        raise RegionError("regions must be a list of 1 to 64 entries")
    seen = set()
    for r in regions:
        validate_region(r)
        if r["id"] in seen:
            raise RegionError("duplicate region id: " + r["id"])
        seen.add(r["id"])
    return regions


def validate_region(r):
    if not isinstance(r, dict) or not ID_RE.match(str(r.get("id", ""))):
        raise RegionError("bad region id: %r" % (r.get("id") if isinstance(r, dict) else r))
    name = r.get("name")
    if not isinstance(name, str) or not 1 <= len(name) <= 80:
        raise RegionError("bad name for " + r["id"])
    box = r.get("bbox")
    if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)):
        raise RegionError("bbox must be [west, south, east, north] for " + r["id"])
    w, s, e, n = box
    if not (LON_RANGE[0] <= w < e <= LON_RANGE[1] and LAT_RANGE[0] <= s < n <= LAT_RANGE[1]):
        raise RegionError("bbox outside the UK range for " + r["id"])
    lo, hi = r.get("minzoom", 0), r.get("maxzoom", MAX_ZOOM)
    if not (isinstance(lo, int) and isinstance(hi, int) and 0 <= lo <= hi <= MAX_ZOOM):
        raise RegionError("bad zoom range for " + r["id"])


def extract_command(pmtiles, source, out, region):
    w, s, e, n = region["bbox"]
    cmd = [str(pmtiles), "extract", str(source), str(out), "--bbox=%s,%s,%s,%s" % (w, s, e, n)]
    if region.get("maxzoom", MAX_ZOOM) < MAX_ZOOM:
        cmd.append("--maxzoom=%d" % region["maxzoom"])
    if region.get("minzoom", 0) > 0:
        cmd.append("--minzoom=%d" % region["minzoom"])
    return cmd


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fp:
        for part in iter(lambda: fp.read(1 << 20), b""):
            h.update(part)
    return h.hexdigest()


def pack_entry(region, size, sha256, version, base_url):
    if not MIN_PACK_BYTES <= size <= MAX_PACK_BYTES:
        raise RegionError("pack %s is %d bytes, outside %d..%d" % (region["id"], size, MIN_PACK_BYTES, MAX_PACK_BYTES))
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise RegionError("bad sha256 for " + region["id"])
    return {
        "id": region["id"],
        "name": region["name"],
        "bbox": list(region["bbox"]),
        "minzoom": region.get("minzoom", 0),
        "maxzoom": region.get("maxzoom", MAX_ZOOM),
        "bundled": bool(region.get("bundled", False)),
        "version": version,
        "bytes": size,
        "sha256": sha256,
        "urls": ["%s/%s.pmtiles" % (base_url.rstrip("/"), region["id"])],
    }


def build_manifest(source, packs, version, generated):
    return {
        "schema": SCHEMA,
        "generated": generated,
        "version": version,
        "format": "pmtiles-v3",
        "tile_type": "mvt",
        "attribution": "(c) OpenStreetMap contributors, ODbL 1.0",
        "source": source,
        "packs": packs,
    }


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--source", required=True, help="local united-kingdom.pmtiles")
    p.add_argument("--source-tag", required=True)
    p.add_argument("--source-asset", default="united-kingdom.pmtiles")
    p.add_argument("--pmtiles", required=True, help="pinned pmtiles binary")
    p.add_argument("--out", required=True)
    p.add_argument("--version", required=True, help="YYYYMMDD")
    p.add_argument("--base-url", required=True, help="release download URL prefix for the packs")
    p.add_argument("--regions", default="tiles/map-pack-regions.json")
    p.add_argument("--generated", required=True)
    a = p.parse_args(argv)
    if not re.fullmatch(r"\d{8}", a.version):
        raise SystemExit("--version must be YYYYMMDD")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    source = Path(a.source)
    packs = []
    for region in load_regions(a.regions):
        target = out / (region["id"] + ".pmtiles")
        target.unlink(missing_ok=True)
        print("::group::extract", region["id"], flush=True)
        subprocess.run(extract_command(a.pmtiles, source, target, region), check=True)
        size = target.stat().st_size
        entry = pack_entry(region, size, sha256_file(target), a.version, a.base_url)
        print("%-22s %8.1f MB" % (region["id"], size / 1e6), flush=True)
        print("::endgroup::")
        packs.append(entry)
    manifest = build_manifest(
        {"tag": a.source_tag, "asset": a.source_asset, "bytes": source.stat().st_size},
        packs, a.version, a.generated)
    (out / "map-packs.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print("wrote map-packs.json with %d packs, %.1f MB in total" % (len(packs), sum(x["bytes"] for x in packs) / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
