#!/usr/bin/env python3
"""Validate bundled UK boundaries and upstream world source BEFORE tile builds.

Boundary files come from Geofabrik's official public polygon GitHub repository,
pinned in this map-data repository under tiles/boundaries/. Keeping these small
ODbL clipping sources local avoids intermittent Geofabrik polygon HTTP 404s.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
import subprocess
import sys

from tile_catalog import parse_poly

UA = "DriveMate-map-preflight/2.0 (ODbL map data)"
WORLD_PATTERN = re.compile(r"^https://build\.protomaps\.com/\d{8}\.pmtiles$")
BOUNDARY_DIR = Path("tiles/boundaries")
REQUIRED = {"england", "scotland", "wales", "northern-ireland"}
REGION_POINTS = {
    "england": [-0.1278, 51.5074],       # London
    "scotland": [-3.1883, 55.9533],      # Edinburgh
    "wales": [-3.1791, 51.4816],         # Cardiff
}
UK_POINTS = [REGION_POINTS["england"], REGION_POINTS["scotland"],
             REGION_POINTS["wales"], [-5.93, 54.597]]  # Belfast


class PreflightError(RuntimeError):
    pass


def rings_of(geometry):
    if not isinstance(geometry, dict):
        raise PreflightError("GeoJSON polygon must be an object")
    if geometry.get("type") == "Polygon":
        polygons = [geometry.get("coordinates")]
    elif geometry.get("type") == "MultiPolygon":
        polygons = geometry.get("coordinates")
    else:
        raise PreflightError("Polygon or MultiPolygon required")
    if not isinstance(polygons, list) or not polygons:
        raise PreflightError("Empty polygon geometry")
    for polygon in polygons:
        if not isinstance(polygon, list) or not polygon:
            raise PreflightError("Empty polygon")
        for ring in polygon:
            if not isinstance(ring, list) or len(ring) < 4 or ring[0] != ring[-1]:
                raise PreflightError("Invalid or unclosed polygon ring")
            for pair in ring:
                if not isinstance(pair, list) or len(pair) < 2:
                    raise PreflightError("Non-coordinate in ring")
                x, y = pair[:2]
                if not all(isinstance(v, (int, float)) and not isinstance(v, bool)
                           and math.isfinite(v) for v in (x, y)):
                    raise PreflightError("Non-finite coordinate")
                # Geofabrik uses generous ocean buffers west of Scotland.
                if not (-16 < x < 4 and 48 < y < 62):
                    raise PreflightError("Polygon vertex outside UK clipping envelope")
            yield ring


def point_in_ring(point, ring):
    x, y = point
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][:2]
        xj, yj = ring[j][:2]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def includes_point(geometry, point):
    polys = ([geometry["coordinates"]] if geometry["type"] == "Polygon"
             else geometry["coordinates"])
    return any(point_in_ring(point, polygon[0]) and not any(
        point_in_ring(point, hole) for hole in polygon[1:])
        for polygon in polys)


def load_local_region(name, folder=BOUNDARY_DIR):
    if name not in REQUIRED | {"united-kingdom"}:
        raise PreflightError("Unexpected source polygon")
    file = Path(folder) / (name + ".poly")
    if not file.is_file() or not 150 <= file.stat().st_size <= 300_000:
        raise PreflightError(f"Missing or implausible bundled Geofabrik polygon: {file}")
    try:
        geojson = parse_poly(file.read_text(encoding="utf8"))
    except (ValueError, IndexError, TypeError) as exc:
        raise PreflightError(f"Bad Geofabrik source polygon for {name}: {exc}") from exc
    list(rings_of(geojson))
    points = UK_POINTS if name == "united-kingdom" else [REGION_POINTS[name]]
    for point in points:
        if not includes_point(geojson, point):
            raise PreflightError(f"{name} boundary excludes reference UK city {point}")
    return geojson, file


def select_world_source(max_days=11):
    for offset in range(max_days):
        date = (datetime.now(timezone.utc) - timedelta(days=offset)).strftime("%Y%m%d")
        url = f"https://build.protomaps.com/{date}.pmtiles"
        probe = subprocess.run(["curl", "-fsSI", "--connect-timeout", "8",
                                "--max-time", "15", "-A", UA, url],
                               capture_output=True, text=True, check=False)
        if probe.returncode == 0:
            return url
    raise PreflightError("No recent Protomaps world outline source available")


def run(config, output):
    cfg = json.loads(Path(config).read_text(encoding="utf8"))
    regions = cfg.get("regions")
    if (not isinstance(regions, list) or len(regions) != 4
            or {r.get("name") for r in regions} != REQUIRED):
        raise PreflightError("Exactly England, Scotland, Wales and Northern Ireland required")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    uk_geom, uk_source = load_local_region("united-kingdom")
    print("Verified UK base clip", uk_source, flush=True)
    for region in regions:
        name = region["name"]
        if name in REGION_POINTS:
            if region.get("polygon_file") != str(BOUNDARY_DIR / (name + ".poly")):
                raise PreflightError("Unexpected polygon file in regions configuration")
            if region.get("reference_point") != REGION_POINTS[name]:
                raise PreflightError("Incorrect UK region validation point")
            geometry, source = load_local_region(name)
            target = output / (name + ".geojson")
            temp = target.with_suffix(".geojson.staged")
            temp.write_text(json.dumps(geometry, separators=(",", ":")) + "\n")
            temp.replace(target)
            print("Verified", name, "geometry from", source, flush=True)
        elif region.get("bbox") != [-8.25, 53.98, -5.35, 55.40]:
            raise PreflightError("Incorrect Northern Ireland clip bbox")
    url = select_world_source()
    if not WORLD_PATTERN.fullmatch(url):
        raise PreflightError("Unexpected world source URL")
    (output / "world-source.txt").write_text(url + "\n")
    print("Verified global overview source", url, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="tiles/regions.json")
    parser.add_argument("--dest", default="work")
    args = parser.parse_args()
    run(args.config, args.dest)


if __name__ == "__main__":
    try:
        main()
    except (PreflightError, OSError, ValueError) as exc:
        print("UK tile input preflight FAILED:", exc, file=sys.stderr)
        sys.exit(2)
