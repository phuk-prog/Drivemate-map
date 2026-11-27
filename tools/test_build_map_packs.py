import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_map_packs as b

REGIONS = Path(__file__).resolve().parents[1] / "tiles" / "map-pack-regions.json"
SHA = "a" * 64


def region(**kw):
    r = {"id": "test-area", "name": "Test area", "bbox": [-3.0, 53.0, -2.0, 54.0], "minzoom": 0, "maxzoom": 14}
    r.update(kw)
    return r


class RegionTests(unittest.TestCase):
    def test_shipped_regions_are_valid(self):
        regions = b.load_regions(REGIONS)
        ids = [r["id"] for r in regions]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn("uk-base", ids)
        base = next(r for r in regions if r["id"] == "uk-base")
        self.assertEqual(base["maxzoom"], 10)
        self.assertTrue(base["bundled"])

    def test_every_uk_point_is_in_some_detailed_region(self):
        # A few real places that must be covered by a full-detail pack.
        places = {"Stockport": (-2.16, 53.41), "Cheadle": (-2.21, 53.39), "Cardiff": (-3.18, 51.48),
                  "Glasgow": (-4.25, 55.86), "Belfast": (-5.93, 54.6), "London": (-0.12, 51.51),
                  "Plymouth": (-4.14, 50.37), "Newcastle": (-1.61, 54.98), "Norwich": (1.3, 52.63)}
        detailed = [r for r in b.load_regions(REGIONS) if r["maxzoom"] == 14]
        for name, (lon, lat) in places.items():
            self.assertTrue(any(r["bbox"][0] <= lon <= r["bbox"][2] and r["bbox"][1] <= lat <= r["bbox"][3]
                                for r in detailed), name)

    def test_rejects_bad_regions(self):
        for bad in (region(id="Bad Id"), region(id=""), region(name=""), region(bbox=[1, 2, 3]),
                    region(bbox=[-3, 53, -4, 54]), region(bbox=[-30, 53, -2, 54]),
                    region(bbox=[-3, 40, -2, 54]), region(minzoom=5, maxzoom=3), region(maxzoom=20)):
            with self.assertRaises(b.RegionError, msg=str(bad)):
                b.validate_region(bad)

    def test_duplicate_ids_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "r.json"
            p.write_text(json.dumps({"regions": [region(), region()]}))
            with self.assertRaises(b.RegionError):
                b.load_regions(p)


class CommandTests(unittest.TestCase):
    def test_full_detail_has_no_zoom_flags(self):
        cmd = b.extract_command("pmtiles", "uk.pmtiles", "out.pmtiles", region())
        self.assertEqual(cmd[:4], ["pmtiles", "extract", "uk.pmtiles", "out.pmtiles"])
        self.assertIn("--bbox=-3.0,53.0,-2.0,54.0", cmd)
        self.assertFalse(any(c.startswith("--maxzoom") for c in cmd))

    def test_overview_limits_zoom(self):
        cmd = b.extract_command("pmtiles", "uk.pmtiles", "o.pmtiles", region(maxzoom=10))
        self.assertIn("--maxzoom=10", cmd)


class ManifestTests(unittest.TestCase):
    def test_entry_and_manifest(self):
        e = b.pack_entry(region(bundled=True), 5_000_000, SHA, "20261127", "https://example.test/dl/")
        self.assertEqual(e["urls"], ["https://example.test/dl/test-area.pmtiles"])
        self.assertTrue(e["bundled"])
        m = b.build_manifest({"tag": "t", "asset": "a", "bytes": 1}, [e], "20261127", "2026-11-27T00:00:00Z")
        self.assertEqual(m["schema"], 1)
        self.assertEqual(m["packs"][0]["sha256"], SHA)
        json.dumps(m)

    def test_size_limits(self):
        with self.assertRaises(b.RegionError):
            b.pack_entry(region(), 5, SHA, "20261127", "https://x")
        with self.assertRaises(b.RegionError):
            b.pack_entry(region(), 2_100_000_000, SHA, "20261127", "https://x")
        with self.assertRaises(b.RegionError):
            b.pack_entry(region(), 5_000_000, "nothex", "20261127", "https://x")

    def test_sha256_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "f"
            p.write_bytes(b"abc")
            self.assertEqual(b.sha256_file(p), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")


if __name__ == "__main__":
    unittest.main()
