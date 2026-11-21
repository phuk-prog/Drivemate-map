"""Wells pilot pack: reproducible build, header bounds and real street names (stdlib only)."""
import gzip
import json
import struct
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "pilot" / "wells-z12-16.pmtiles"
sys.path.insert(0, str(ROOT / "tools"))
import build_pilot_pack as bp  # noqa: E402


class PilotPackTest(unittest.TestCase):
    def test_committed_pack_matches_fresh_build(self):
        r = subprocess.run([sys.executable, str(ROOT / "tools" / "build_pilot_pack.py"), "--check"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_header_bounds_zooms_and_attribution(self):
        data = PACK.read_bytes()
        self.assertEqual(data[:7], b"PMTiles")
        self.assertEqual(data[7], 3)
        self.assertEqual((data[97], data[98], data[99], data[100], data[101]), (2, 2, 1, 12, 16))
        min_lon, min_lat, max_lon, max_lat = (v / 1e7 for v in struct.unpack_from("<iiii", data, 102))
        self.assertEqual((min_lat, min_lon, max_lat, max_lon), bp.BBOX)
        meta_off, meta_len = struct.unpack_from("<QQ", data, 24)
        meta = json.loads(gzip.decompress(data[meta_off:meta_off + meta_len]))
        self.assertIn("OpenStreetMap contributors", meta["attribution"])
        self.assertEqual(meta["source"]["sha256"], bp.SOURCE_SHA256)

    def test_known_wells_streets_are_in_the_pack(self):
        pack, counts, _ = bp.build_pack(str(ROOT / bp.SOURCE))
        self.assertEqual(counts["roads"], 965)  # every complete highway way in the extract
        tiles = bp.build_tiles(bp.load_features(str(ROOT / bp.SOURCE)))
        blob = b"".join(tiles.values())
        for name in (b"High Street", b"Sadler Street", b"Market Place", b"Wells Town Hall"):
            self.assertIn(name, blob)

    def test_no_tile_outside_pilot_bbox(self):
        tiles = bp.build_tiles(bp.load_features(str(ROOT / bp.SOURCE)))
        allowed = set()
        for z in range(bp.MIN_ZOOM, bp.MAX_ZOOM + 1):
            n = 1 << z
            for x in range(int(bp.unit_x(bp.BBOX[1]) * n), int(bp.unit_x(bp.BBOX[3]) * n) + 1):
                for y in range(int(bp.unit_y(bp.BBOX[2]) * n), int(bp.unit_y(bp.BBOX[0]) * n) + 1):
                    allowed.add(bp.tile_id(z, x, y))
        self.assertTrue(set(tiles) <= allowed)


if __name__ == "__main__":
    unittest.main()
