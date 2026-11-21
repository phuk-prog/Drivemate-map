"""Offline tests for pinned UK map boundary files and early tile-build checks."""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import preflight_tile_inputs as pf


class PreflightTests(unittest.TestCase):
    def square(self, west=-1, south=51, east=1, north=53):
        ring = [[west, south], [east, south], [east, north],
                [west, north], [west, south]]
        return {"type": "Polygon", "coordinates": [ring]}

    def test_bundled_official_polygons_cover_all_uk_capitals(self):
        for name in ("united-kingdom", "england", "scotland", "wales"):
            with self.subTest(name=name):
                geometry, file = pf.load_local_region(name)
                self.assertTrue(file.is_file())
                self.assertTrue(len(list(pf.rings_of(geometry))) >= 1)

    def test_geometry_contains_reference_city_and_rejects_wrong_area(self):
        geometry = self.square()
        self.assertTrue(pf.includes_point(geometry, [0, 52]))
        self.assertFalse(pf.includes_point(geometry, [0, 55]))

    def test_geometry_rejects_invalid_or_out_of_uk_coordinates(self):
        bad = [
            {"type": "Point", "coordinates": [0, 52]},
            {"type": "Polygon", "coordinates": [[[0, 52], [1, 52], [1, 53]]]},
            self.square(-30, 52, -29, 53),
            {"type": "Polygon", "coordinates": [[["nan", 50], [1, 50], [1, 51], ["nan", 50]]]},
        ]
        for geometry in bad:
            with self.subTest(geometry=geometry):
                with self.assertRaises(pf.PreflightError):
                    list(pf.rings_of(geometry))

    def test_boundary_load_rejects_missing_and_tiny_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(pf.PreflightError, "Missing"):
                pf.load_local_region("england", Path(tmp))
            file = Path(tmp) / "england.poly"
            file.write_text("polygon\n1\n0 0\nEND\nEND\n")
            with self.assertRaisesRegex(pf.PreflightError, "implausible"):
                pf.load_local_region("england", Path(tmp))
        with self.assertRaisesRegex(pf.PreflightError, "Unexpected"):
            pf.load_local_region("../passwords")

    def test_recent_world_source_fallback(self):
        answers = iter((1, 0))
        with mock.patch.object(pf.subprocess, "run",
                               side_effect=lambda *a, **k: SimpleNamespace(returncode=next(answers))), \
             mock.patch.object(pf, "datetime") as today:
            today.now.return_value = datetime(2026, 11, 20, tzinfo=timezone.utc)
            source = pf.select_world_source()
        self.assertEqual(source, "https://build.protomaps.com/20261119.pmtiles")

    def test_missing_required_regions_fail_before_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "bad.json"
            config.write_text(json.dumps({"regions": [{"name": "england"}]}))
            with self.assertRaisesRegex(pf.PreflightError, "Exactly"):
                pf.run(config, Path(tmp) / "preflight")

    def test_live_preflight_converts_pinned_polygons_to_geojson(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(pf, "select_world_source",
                    return_value="https://build.protomaps.com/20261120.pmtiles"):
                pf.run("tiles/regions.json", Path(tmp))
            for name in ("england", "scotland", "wales"):
                filename = Path(tmp) / (name + ".geojson")
                self.assertTrue(filename.is_file(), name)
                doc = json.loads(filename.read_text())
                self.assertTrue(list(pf.rings_of(doc)))
                self.assertTrue(pf.includes_point(doc, pf.REGION_POINTS[name]))
            self.assertEqual((Path(tmp) / "world-source.txt").read_text().strip(),
                             "https://build.protomaps.com/20261120.pmtiles")

    def test_misconfigured_region_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = json.loads(Path("tiles/regions.json").read_text())
            config["regions"][0]["polygon_file"] = "../other.poly"
            f = Path(tmp) / "bad.json"
            f.write_text(json.dumps(config))
            with mock.patch.object(pf, "select_world_source",
                                   return_value="https://build.protomaps.com/20261120.pmtiles"):
                with self.assertRaisesRegex(pf.PreflightError, "Unexpected polygon file"):
                    pf.run(f, Path(tmp) / "work")


if __name__ == "__main__":
    unittest.main()
