import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compare_with_valhalla as cmp


def ok(km, seconds, coverage):
    return {"ok": True, "km": km, "seconds": seconds, "coverage": coverage}


FAIL = {"ok": False}


class Polyline(unittest.TestCase):
    def test_decodes_valhalla_precision6(self):
        # Encoded with precision 6 from (38.5,-120.2),(40.7,-120.95),(43.252,-126.453)
        shape = "_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI"
        pts = cmp.decode_polyline6(shape)
        expected = [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]
        self.assertEqual(len(pts), 3)
        for (a, b), (c, d) in zip(pts, expected):
            self.assertAlmostEqual(a, c, places=6)
            self.assertAlmostEqual(b, d, places=6)


class Geometry(unittest.TestCase):
    line = [(54.0, -1.0), (54.0, -0.99)]          # about 650 m east-west
    parallel_far = [(54.002, -1.0), (54.002, -0.99)]  # about 220 m north

    def test_identical_routes_fully_covered(self):
        self.assertGreater(cmp.coverage(self.line, cmp.PointIndex(self.line)), 0.99)

    def test_distant_route_not_covered(self):
        self.assertEqual(cmp.coverage(self.parallel_far, cmp.PointIndex(self.line)), 0.0)

    def test_first_split_reports_way(self):
        ours = [(54.0, -1.0), (54.0, -0.995), (54.003, -0.995)]
        split = cmp.first_split(ours, [11, 22], cmp.PointIndex(self.line))
        self.assertEqual(split["osm_way"], 22)
        self.assertAlmostEqual(split["lat"], 54.003)

    def test_no_split_when_same(self):
        self.assertIsNone(cmp.first_split(self.line, [1], cmp.PointIndex(self.line)))


class SnapComponents(unittest.TestCase):
    def test_strong_components_split_one_way_fragment(self):
        from compile_dmtiles_uk import strong_components
        # 0<->1<->2 is a two-way loop; 3 can only be entered (dead one-way spur);
        # 4<->5 is a separate two-node island.
        src = [0, 1, 1, 2, 2, 4, 5]
        dst = [1, 0, 2, 1, 3, 5, 4]
        comp, sizes = strong_components(6, src, dst)
        self.assertEqual(comp[0], comp[1])
        self.assertEqual(comp[1], comp[2])
        self.assertNotEqual(comp[2], comp[3])
        self.assertEqual(comp[4], comp[5])
        self.assertEqual(sorted(sizes), [1, 2, 3])

    def test_snap_flags_start_and_end_separately(self):
        import compile_dmtiles_uk as c
        src, dst = [], []
        for i in range(60):  # two-way ring: a real road network
            j = (i + 1) % 60
            src += [i, j]
            dst += [j, i]
        src += [5, 60]; dst += [60, 61]    # one-way spur leaving the ring: can only end there
        src += [62, 63]; dst += [63, 7]    # one-way spur joining the ring: can only start there
        src += [64, 65]; dst += [65, 64]   # isolated two-node island
        f = c.snap_flags(66, src, dst)
        self.assertEqual(f[0], c.SNAP_BOTH)
        self.assertEqual(f[61], c.SNAP_END_ONLY)
        self.assertEqual(f[62], c.SNAP_START_ONLY)
        self.assertEqual(f[64], c.SNAP_NONE)
        self.assertEqual((c.SNAP_BOTH, c.SNAP_NONE), (1, 0))  # older tiles keep their meaning


class Classify(unittest.TestCase):
    def test_failures(self):
        self.assertEqual(cmp.classify(FAIL, FAIL)[0], "both_failed")
        self.assertEqual(cmp.classify(FAIL, ok(10, 600, 0))[0], "ours_failed")
        self.assertEqual(cmp.classify(ok(10, 600, 0), FAIL)[0], "valhalla_failed")

    def test_match(self):
        self.assertEqual(cmp.classify(ok(10, 600, 0.95), ok(10.1, 590, 0.97))[0], "match")

    def test_shorter_flags_possible_missed_restriction(self):
        # Valhalla could not time our route: a much shorter route is suspect.
        self.assertEqual(cmp.classify(ok(8, 500, 0.4), ok(10, 600, 0.3))[0], "ours_shorter")

    def test_shorter_but_valhalla_times_it_equal_is_fine(self):
        self.assertEqual(cmp.classify(ok(8, 500, 0.4), ok(10, 600, 0.3), ours_vh_seconds=590)[0],
                         "equivalent")

    def test_slower_uses_valhalla_time_of_our_route(self):
        verdict, facts = cmp.classify(ok(10.5, 700, 0.5), ok(10, 600, 0.5), ours_vh_seconds=720)
        self.assertEqual(verdict, "ours_slower")
        self.assertEqual(facts["valhalla_time_ratio_of_our_route"], 1.2)

    def test_two_percent_bands(self):
        self.assertEqual(cmp.classify(ok(10.2, 600, 0.5), ok(10, 600, 0.5), ours_vh_seconds=630)[0], "valhalla_better")
        self.assertEqual(cmp.classify(ok(10.2, 600, 0.5), ok(10, 600, 0.5), ours_vh_seconds=580)[0], "ours_better")
        self.assertEqual(cmp.classify(ok(10.2, 600, 0.5), ok(10, 600, 0.5), ours_vh_seconds=605)[0], "equivalent")

    def test_equivalent_alternative(self):
        self.assertEqual(cmp.classify(ok(10.2, 610, 0.5), ok(10, 600, 0.5), ours_vh_seconds=608)[0],
                         "equivalent")


class Reporting(unittest.TestCase):
    def report(self, verdicts):
        recs = [{"name": f"j{i}", "verdict": v, "ours": {"ok": False, "reason": "x"},
                 "valhalla": {"ok": False}} for i, v in enumerate(verdicts)]
        counts, pct = cmp.score(recs)
        return {"source_sha256": "a" * 64, "journeys": recs,
                "summary": {"journeys": len(recs), "counts": counts, "score": pct}}

    def test_score_excludes_both_failed(self):
        r = self.report(["match", "ours_failed", "both_failed", "equivalent"])
        self.assertEqual(r["summary"]["score"], 66.7)

    def test_regression_detected(self):
        before = self.report(["match", "ours_failed"])
        after = self.report(["ours_slower", "match"])
        self.assertEqual(cmp.regressions(after, before), ["j0"])

    def test_markdown_lists_changes(self):
        before = self.report(["ours_failed"])
        after = self.report(["match"])
        md = cmp.markdown(after, before)
        self.assertIn("Changed since baseline", md)
        self.assertIn("+100.0", md)
        json.dumps(after)


if __name__ == "__main__":
    unittest.main()
