"""The road hierarchy must give exactly the same route cost as a full search."""
import itertools
import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from benchmark_dmtiles_uk import Archive
from build_uk_roads import Builder, publish
from compile_dmtiles_uk import compile_graph
from dm_overlay import build_overlay
from verify_uk_graph import metres


def grid_network(db):
    """8x8 grid of roads, 0.02 degrees apart, spread over a 4x4 block of
    0.05-degree cells, with one-way streets, mixed speeds and a banned turn."""
    b = Builder(db)
    rng = random.Random(7)
    nid = lambda i, j: 1000 + i * 10 + j
    pos = lambda i, j: (51.001 + 0.021 * i, -2.199 + 0.021 * j)
    way = 1
    kinds = ["residential", "tertiary", "primary", "unclassified"]
    for i in range(8):
        for j in range(8):
            for di, dj in ((1, 0), (0, 1)):
                a, c = (i, j), (i + di, j + dj)
                if c[0] > 7 or c[1] > 7:
                    continue
                tags = {"highway": rng.choice(kinds)}
                if rng.random() < 0.2:
                    tags["oneway"] = "yes"
                b.way(way, tags, [(nid(*a), *pos(*a)), (nid(*c), *pos(*c))])
                way += 1
    # No right turn from way 1 (row 0, j=0 -> i=1) onto way 2 at node (1,0).
    b.turn({"type": "restriction", "restriction": "no_left_turn"},
           [("from", "w", 1), ("via", "n", nid(1, 0)), ("to", "w", 3)])
    return b, [pos(i, j) for i in range(8) for j in range(8)]


class OverlayMatchesFullSearch(unittest.TestCase):
    def test_every_pair_same_cost_and_connected_path(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            b, points = grid_network(p / "roads.sqlite")
            tag, sha = "uk-map-20261122T084645Z-9013a4487fa6", "a" * 64
            stats = b.finish(tag, sha, min_edges=1)
            m = publish(p / "roads.sqlite", p / "release", tag, sha, stats, part_bytes=1 << 20)
            doc = compile_graph(p / "roads.sqlite", m, p / "tiles", pilot=True)
            self.assertGreater(len(doc["tiles"]), 4)
            build_overlay(p / "tiles")
            ar = Archive(p / "tiles" / "manifest.json", p / "tiles" / "routing.dma")
            self.assertTrue(ar.use_overlay)
            checked = 0
            for s, e in itertools.permutations(points[::3], 2):
                ar.use_overlay = False
                flat = ar.route(s, e, 10**7, 60)
                ar.use_overlay = True
                over = ar.route(s, e, 10**7, 60)
                self.assertEqual(flat["ok"], over["ok"], (s, e))
                if not flat["ok"]:
                    continue
                checked += 1
                # Results are rounded to 0.01 s / 1 m; integer vs float sums differ by that.
                self.assertAlmostEqual(flat["seconds"], over["seconds"], delta=0.015, msg=(s, e))
                self.assertAlmostEqual(flat["distance_km"], over["distance_km"], delta=0.0015)
                # Unpacked overlay path is continuous, ends at the snapped goal.
                self.assertEqual(len(over["path"]), len(over["ways"]) + 1)
                for a, c in zip(over["path"], over["path"][1:]):
                    self.assertLess(metres(a[1:], c[1:]), 3000)
                self.assertLess(metres(over["path"][-1][1:], e), 400)
            self.assertGreater(checked, 100)

    def test_corrupt_overlay_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            b, _ = grid_network(p / "roads.sqlite")
            tag, sha = "uk-map-20261122T084645Z-9013a4487fa6", "a" * 64
            m = publish(p / "roads.sqlite", p / "release", tag, sha,
                        b.finish(tag, sha, min_edges=1), part_bytes=1 << 20)
            compile_graph(p / "roads.sqlite", m, p / "tiles", pilot=True)
            build_overlay(p / "tiles")
            ov = p / "tiles" / "overlay.dmo"
            data = bytearray(ov.read_bytes())
            data[10] ^= 1
            ov.write_bytes(bytes(data))
            with self.assertRaises(ValueError):
                Archive(p / "tiles" / "manifest.json", p / "tiles" / "routing.dma")


if __name__ == "__main__":
    unittest.main()
