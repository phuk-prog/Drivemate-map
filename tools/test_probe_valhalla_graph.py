"""Native routing QA must reject missing routes, instructions and UK coverage."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from probe_valhalla_graph import check_response, probe, request, SAMPLES


def response():
    return {"trip": {
        "summary": {"time": 1200, "length": 17.3},
        "legs": [{
            "shape": "encoded-polyline6-fixture",
            "maneuvers": [
                {"type": 1, "begin_shape_index": 0, "end_shape_index": 4,
                 "instruction": "Head onto the A road"},
                {"type": 4, "begin_shape_index": 4, "end_shape_index": 4,
                 "instruction": "You have arrived"},
            ]
        }]
    }}


class RouteProbeTest(unittest.TestCase):
    def test_valid_engine_manoeuvres_and_summary(self):
        parsed = check_response(json.dumps(response()))
        self.assertEqual(parsed["time_seconds"], 1200)
        self.assertEqual(parsed["manoeuvres"], 2)

    def test_fails_closed_on_missing_route_shape_or_manoeuvre(self):
        for mutation in ("trip", "shape", "maneuvers", "instruction", "time"):
            doc = response()
            if mutation == "trip":
                doc.pop("trip")
            elif mutation == "shape":
                doc["trip"]["legs"][0].pop("shape")
            elif mutation == "maneuvers":
                doc["trip"]["legs"][0]["maneuvers"] = []
            elif mutation == "instruction":
                doc["trip"]["legs"][0]["maneuvers"][1]["instruction"] = ""
            else:
                doc["trip"]["summary"]["time"] = 0
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                check_response(json.dumps(doc))

    def test_real_uk_samples_cover_all_nations_and_cross_border(self):
        names = " ".join(x[0] for x in SAMPLES)
        self.assertIn("Birmingham", names)
        self.assertIn("Bristol", names)
        self.assertIn("Carlisle", names)
        self.assertIn("Edinburgh", names)
        self.assertIn("Belfast", names)
        self.assertEqual(len(SAMPLES), 5)
        self.assertIn('"costing":"auto"', request(*SAMPLES[0][1:]))

    def test_all_samples_must_succeed_no_dummy_route_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / "valhalla-output" / "valhalla.json"
            config.parent.mkdir(parents=True)
            config.write_text("{}")
            def good(cmd, **kw):
                self.assertIn("valhalla_service", cmd)
                self.assertIn("route", cmd)
                return SimpleNamespace(returncode=0, stdout=json.dumps(response()),
                                       stderr="")
            self.assertTrue(probe(root, "valhalla-output/valhalla.json",
                                  run=good)["passed"])
            attempts = []
            def failing(cmd, **kw):
                attempts.append(cmd)
                if len(attempts) == 3:
                    return SimpleNamespace(returncode=1, stdout="",
                                           stderr="No connected route")
                return good(cmd, **kw)
            answer = probe(root, "valhalla-output/valhalla.json", run=failing)
            self.assertFalse(answer["passed"])
            self.assertEqual(len(attempts), 5)
            self.assertEqual(sum(not row["passed"] for row in answer["samples"]), 1)


if __name__ == "__main__":
    unittest.main()
