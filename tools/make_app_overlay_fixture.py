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
from dm_overlay import build_level2, build_overlay
from test_dm_overlay import grid_network


def write_fixture(tiles, doc, out, expected):
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shutil.copy(tiles / "manifest.json", out / "manifest.json")
    for archive, key in (("routing.dma", None), ("overlay.dmo", "overlay"), ("overlay2.dmo", "overlay2")):
        cells = doc["tiles"] if key is None else doc[key]["cells" if key == "overlay" else "blocks"]
        raw = (tiles / archive).read_bytes()
        for meta in cells.values():
            (out / meta["name"]).write_bytes(raw[meta["offset"]:meta["offset"] + meta["bytes"]])
    (out / "expected.json").write_text(json.dumps(expected, indent=0) + "\n")


def via_way_fixture(out):
    """The via-way network from test_via_way.py: restricted, allowed and
    side-road journeys, with this repository's results."""
    import compile_dmtiles_uk
    import test_via_way as tv
    old = compile_dmtiles_uk.MIN_SNAP_COMPONENT
    compile_dmtiles_uk.MIN_SNAP_COMPONENT = 1
    try:
        with tempfile.TemporaryDirectory() as d:
            _, ar = tv.build(d, "no_right_turn")
            ar.use_overlay = False
            expected = []
            for a, b in itertools.permutations(tv.P, 2):
                r = ar.route(tv.P[a], tv.P[b], 10**6, 30)
                expected.append({"start": tv.P[a], "end": tv.P[b], "ok": r["ok"],
                                 "seconds": r.get("seconds"), "km": r.get("distance_km"),
                                 "ways": r.get("ways")})
            tiles = Path(d) / "tiles"
            write_fixture(tiles, json.loads((tiles / "manifest.json").read_text()), out, expected)
    finally:
        compile_dmtiles_uk.MIN_SNAP_COMPONENT = old
    print(len(expected), "via-way journeys;", sum(1 for x in expected if x["ok"]), "routable")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--via-way-out", type=Path, help="also write the via-way restriction fixture here")
    a = p.parse_args(argv)
    if a.via_way_out:
        via_way_fixture(a.via_way_out)
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        b, points = grid_network(d / "roads.sqlite")
        tag, sha = "uk-map-20261122T084645Z-9013a4487fa6", "a" * 64
        m = publish(d / "roads.sqlite", d / "release", tag, sha, b.finish(tag, sha, min_edges=1), part_bytes=1 << 20)
        compile_graph(d / "roads.sqlite", m, d / "tiles", pilot=True)
        build_overlay(d / "tiles")
        # Small blocks so the 9-cell grid spans several level-2 blocks.
        doc = build_level2(d / "tiles", block=2)
        if a.out.exists():
            shutil.rmtree(a.out)
        a.out.mkdir(parents=True)
        shutil.copy(d / "tiles" / "manifest.json", a.out / "manifest.json")
        for archive, cells in (("routing.dma", doc["tiles"]), ("overlay.dmo", doc["overlay"]["cells"]),
                               ("overlay2.dmo", doc["overlay2"]["blocks"])):
            raw = (d / "tiles" / archive).read_bytes()
            for meta in cells.values():
                (a.out / meta["name"]).write_bytes(raw[meta["offset"]:meta["offset"] + meta["bytes"]])
        ar = Archive(d / "tiles" / "manifest.json", d / "tiles" / "routing.dma")
        ar.use_overlay = False
        expected = []
        for s, e in itertools.permutations(points[::2], 2):
            r = ar.route(s, e, 10**7, 60)
            expected.append({"start": s, "end": e, "ok": r["ok"],
                             "seconds": r.get("seconds"), "km": r.get("distance_km")})
        (a.out / "expected.json").write_text(json.dumps(expected, indent=0) + "\n")
    print(len(expected), "journeys;", sum(1 for x in expected if x["ok"]), "routable")


if __name__ == "__main__":
    raise SystemExit(main())
