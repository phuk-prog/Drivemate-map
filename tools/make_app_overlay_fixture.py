#!/usr/bin/env python3
"""Write a small road-hierarchy test fixture for the Android app's JVM tests.

Uses the same synthetic grid as test_dm_overlay.py, compiled by the real
compiler and overlay builder. Tiles and overlay pieces are written as
separate <cell>.dmt.gz / <cell>.dmo.gz files (what DmTileEngine.Source
serves), plus expected.json: journey times from this repository's full
road-by-road search, so the app test can check its port against it.

  python3 tools/make_app_overlay_fixture.py --out ../Drivemate-app/app/src/test/resources/dm-overlay
"""
import argparse
import itertools
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from benchmark_dmtiles_uk import Archive
from build_uk_roads import publish
from compile_dmtiles_uk import compile_graph
from dm_overlay import build_overlay
from test_dm_overlay import grid_network


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args(argv)
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        b, points = grid_network(d / "roads.sqlite")
        tag, sha = "uk-map-20261122T084645Z-9013a4487fa6", "a" * 64
        m = publish(d / "roads.sqlite", d / "release", tag, sha, b.finish(tag, sha, min_edges=1), part_bytes=1 << 20)
        compile_graph(d / "roads.sqlite", m, d / "tiles", pilot=True)
        doc = build_overlay(d / "tiles")
        if a.out.exists():
            shutil.rmtree(a.out)
        a.out.mkdir(parents=True)
        shutil.copy(d / "tiles" / "manifest.json", a.out / "manifest.json")
        for archive, cells in (("routing.dma", doc["tiles"]), ("overlay.dmo", doc["overlay"]["cells"])):
            raw = (d / "tiles" / archive).read_bytes()
            for meta in cells.values():
                (a.out / meta["name"]).write_bytes(raw[meta["offset"]:meta["offset"] + meta["bytes"]])
        ar = Archive(d / "tiles" / "manifest.json", d / "tiles" / "routing.dma")
        ar.use_overlay = False
        expected = []
        for s, e in itertools.permutations(points[::3], 2):
            r = ar.route(s, e, 10**7, 60)
            expected.append({"start": s, "end": e, "ok": r["ok"],
                             "seconds": r.get("seconds"), "km": r.get("distance_km")})
        (a.out / "expected.json").write_text(json.dumps(expected, indent=0) + "\n")
    print(len(expected), "journeys;", sum(1 for x in expected if x["ok"]), "routable")


if __name__ == "__main__":
    raise SystemExit(main())
