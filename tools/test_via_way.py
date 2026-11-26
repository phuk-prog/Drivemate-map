"""Via-way turn restrictions ("from A, via link B, to C") are exact: they stop
only traffic that arrives from A, and nothing else."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compile_dmtiles_uk
from benchmark_dmtiles_uk import Archive
from build_uk_roads import Builder, publish
from compile_dmtiles_uk import compile_graph
from dm_overlay import build_level2, build_overlay

TAG, SHA = "uk-map-20261122T084645Z-9013a4487fa6", "a" * 64
#   n12 <-- n11 <-- n10          road A, one-way westbound (way 1)
#           |  B (way 3, two-way link)
#   n22 --> n21 --> n20          road C, one-way eastbound (way 2)
#           |  D (way 5) north of C ... n40
#   n30 --- n11                  side road X from the south into n11 (way 4)
P = {10: (53.0000, -2.0000), 11: (53.0000, -2.0010), 12: (53.0000, -2.0020),
     22: (53.0010, -2.0020), 21: (53.0010, -2.0010), 20: (53.0010, -2.0000),
     30: (52.9990, -2.0010), 40: (53.0020, -2.0010)}


def node(n):
    return (n, *P[n])


def build(tmp, kind, extra_via=False):
    d = Path(tmp)
    b = Builder(d / "roads.sqlite")
    b.way(1, {"highway": "primary", "oneway": "yes"}, [node(10), node(11), node(12)])
    b.way(2, {"highway": "primary", "oneway": "yes"}, [node(22), node(21), node(20)])
    b.way(3, {"highway": "primary"}, [node(11), node(21)])
    b.way(4, {"highway": "residential"}, [node(30), node(11)])
    b.way(5, {"highway": "residential"}, [node(21), node(40)])
    b.turn({"type": "restriction", "restriction": kind},
           [("from", "w", 1), ("via", "w", 3), ("to", "w", 2)])
    stats = b.finish(TAG, SHA, min_edges=1)
    m = publish(d / "roads.sqlite", d / "release", TAG, SHA, stats, part_bytes=1 << 20)
    compile_graph(d / "roads.sqlite", m, d / "tiles", pilot=True)
    build_overlay(d / "tiles", workers=1)
    build_level2(d / "tiles", block=1)
    return stats, Archive(d / "tiles" / "manifest.json", d / "tiles" / "routing.dma")


def routes(ar, a, b):
    out = []
    for overlay in (False, True):
        ar.use_overlay = overlay
        out.append(ar.route(P[a], P[b], 10**6, 30))
    return out


class ViaWay(unittest.TestCase):
    def setUp(self):
        old = compile_dmtiles_uk.MIN_SNAP_COMPONENT
        compile_dmtiles_uk.MIN_SNAP_COMPONENT = 1  # tiny test network
        self.addCleanup(setattr, compile_dmtiles_uk, "MIN_SNAP_COMPONENT", old)

    def test_no_turn_stops_only_traffic_from_a(self):
        with tempfile.TemporaryDirectory() as tmp:
            stats, ar = build(tmp, "no_right_turn")
            self.assertEqual(stats["via_way_exact"], 1)
            for r in routes(ar, 10, 20):   # A -> B -> C is the restricted manoeuvre
                self.assertFalse(r["ok"], r)
            for r in routes(ar, 30, 20):   # X -> B -> C is allowed
                self.assertTrue(r["ok"], r)
            for r in routes(ar, 10, 40):   # A -> B -> D (not C) is allowed
                self.assertTrue(r["ok"], r)
                self.assertNotIn(None, r["ways"])
                self.assertTrue(set(r["ways"]) <= {1, 2, 3, 4, 5}, r["ways"])  # copies reported as OSM ways

    def test_only_turn_forces_traffic_from_a(self):
        with tempfile.TemporaryDirectory() as tmp:
            stats, ar = build(tmp, "only_right_turn")
            for r in routes(ar, 10, 20):   # A -> B -> C is the only way on from B
                self.assertTrue(r["ok"], r)
            for r in routes(ar, 10, 40):   # A -> B -> D is forbidden
                self.assertFalse(r["ok"], r)
            for r in routes(ar, 30, 40):   # X -> B -> D is allowed
                self.assertTrue(r["ok"], r)

    def test_copies_are_never_journey_ends(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, ar = build(tmp, "no_right_turn")
            for origin in (True, False):
                for n in P:
                    hit = ar.near(P[n], origin)
                    if hit:
                        self.assertLess(hit[1][0], 10**12)

    def test_broken_relation_is_ignored_not_road_closing(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = Builder(Path(tmp) / "roads.sqlite")
            b.turn({"type": "restriction", "restriction": "only_straight_on"}, [("from", "w", 7)])
            self.assertEqual(b.stats["ignored_incomplete_or_unknown_restriction"], 1)
            self.assertEqual(b.db.execute("SELECT COUNT(*) FROM blocked_ways").fetchone()[0], 0)
            b.db.close()

    def test_several_to_roads_each_banned(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = Builder(Path(tmp) / "roads.sqlite")
            b.turn({"type": "restriction", "restriction": "no_exit"},
                   [("from", "w", 1), ("via", "n", 11), ("to", "w", 3), ("to", "w", 4)])
            rows = sorted(b.db.execute("SELECT via,from_way,to_way,policy FROM restrictions"))
            self.assertEqual(rows, [(11, 1, 3, 1), (11, 1, 4, 1)])
            b.db.close()


if __name__ == "__main__":
    unittest.main()
