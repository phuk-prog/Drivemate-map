"""Tests for tools/tile_catalog.py (run: python3 -m unittest discover -s tests)."""
import base64
import gzip
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import tile_catalog as tc  # noqa: E402


def make_pmtiles(path, metadata, tile_type=1, minz=0, maxz=14,
                 bounds=(-8.65, 49.86, 1.77, 60.86), payload=b"\x00" * 64):
    """Write a minimal, structurally valid PMTiles v3 file (header + metadata + data)."""
    meta = gzip.compress(json.dumps(metadata).encode())
    root = b"\x00"
    root_off = 127
    meta_off = root_off + len(root)
    data_off = meta_off + len(meta)
    hdr = bytearray(b"PMTiles" + bytes([3]))
    hdr += struct.pack("<11Q", root_off, len(root), meta_off, len(meta), 0, 0,
                       data_off, len(payload), 10, 9, 8)
    hdr += struct.pack("<6B", 1, 2, 2, tile_type, minz, maxz)
    e7 = [int(round(v * 1e7)) for v in bounds]
    hdr += struct.pack("<4i", *e7)
    hdr += bytes([6]) + struct.pack("<2i", int(-1.5e7), int(54e7))
    assert len(hdr) == 127
    Path(path).write_bytes(bytes(hdr) + root + meta + payload)


POLY = """england
1
   -2.0 50.0
   1.0 50.0
   1.0 52.0
   -2.0 52.0
END
!1
   -1.0 50.5
   0.0 50.5
   0.0 51.0
END
2
   -6.0 55.0
   -5.0 55.0
   -5.0 56.0
END
END
"""

SPEC = {"name": "england", "kind": "region", "schema": "shortbread-1.0",
        "attribution": "(c) OpenStreetMap contributors", "data_timestamp": "2026-11-19T05:00:00Z"}


class PolyTest(unittest.TestCase):
    def test_rings_holes_and_closure(self):
        g = tc.parse_poly(POLY)
        self.assertEqual(g["type"], "MultiPolygon")
        self.assertEqual(len(g["coordinates"]), 2)
        outer, hole = g["coordinates"][0]
        self.assertEqual(outer[0], outer[-1])
        self.assertEqual(len(hole), 4)        # closed automatically
        self.assertEqual(tc.geometry_bounds(g), [-6.0, 50.0, 1.0, 56.0])

    def test_rejects_garbage(self):
        with self.assertRaises(ValueError):
            tc.parse_poly("x\n1\n 0 0\n 1 1\n")


class PMTilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_header_and_entry(self):
        p = self.dir / "england.pmtiles"
        make_pmtiles(p, {"attribution": "OSM", "vector_layers": [
            {"id": "streets", "fields": {"kind": "String"}}, {"id": "water_polygons", "fields": {}}]})
        h = tc.read_header(p)
        self.assertEqual(h["tile_type"], "mvt")
        self.assertEqual((h["min_zoom"], h["max_zoom"]), (0, 14))
        self.assertAlmostEqual(h["bounds"][3], 60.86)
        e = tc.catalog_entry(p, SPEC)
        self.assertEqual(e["bytes"], p.stat().st_size)
        self.assertEqual(len(e["sha256"]), 64)
        self.assertEqual(e["vector_layers"], ["streets", "water_polygons"])
        self.assertEqual(e["data_timestamp"], SPEC["data_timestamp"])

    def test_refuses_contributor_identity(self):
        p = self.dir / "bad.pmtiles"
        make_pmtiles(p, {"vector_layers": [{"id": "pois", "fields": {"uid": "Number"}}]})
        with self.assertRaisesRegex(ValueError, "contributor identity"):
            tc.catalog_entry(p, SPEC)

    def test_refuses_raster_and_non_pmtiles(self):
        p = self.dir / "raster.pmtiles"
        make_pmtiles(p, {}, tile_type=2)
        with self.assertRaisesRegex(ValueError, "not Mapbox Vector Tile"):
            tc.catalog_entry(p, SPEC)
        q = self.dir / "junk.pmtiles"
        q.write_bytes(b"x" * 200)
        with self.assertRaises(ValueError):
            tc.read_header(q)


class SigningTest(unittest.TestCase):
    SEED = bytes(range(32))

    def catalog(self):
        return tc.build_catalog([{"name": "x"}], "tiles-test", built_utc="2026-11-19T00:00:00+00:00")

    def test_unsigned_without_key(self):
        cat = self.catalog()
        data, sig = tc.sign_catalog(cat, tc.load_private_key(""))
        self.assertIsNone(sig)
        self.assertEqual(json.loads(data)["signing"]["status"], tc.UNSIGNED)

    def test_sign_verify_and_tamper(self):
        for material in (self.SEED.hex(), base64.b64encode(self.SEED).decode()):
            key = tc.load_private_key(material)
            cat = self.catalog()
            data, sig = tc.sign_catalog(cat, key)
            signing = json.loads(data)["signing"]
            self.assertIn("NOT FOR PRODUCTION", signing["warning"])
            self.assertTrue(tc.verify_signature(data, sig, signing["public_key_base64"]))
            self.assertFalse(tc.verify_signature(data.replace(b"tiles-test", b"tiles-evil"),
                                                 sig, signing["public_key_base64"]))

    def test_pem_key(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        pem = Ed25519PrivateKey.from_private_bytes(self.SEED).private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()).decode()
        self.assertEqual(tc.public_raw(tc.load_private_key(pem)),
                         tc.public_raw(tc.load_private_key(self.SEED.hex())))

    def test_bad_seed_length(self):
        with self.assertRaises(ValueError):
            tc.load_private_key("abcd")


class CliTest(unittest.TestCase):
    def test_build_cli_unsigned(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            p = d / "wales.pmtiles"
            make_pmtiles(p, {"vector_layers": []})
            spec = d / "spec.json"
            spec.write_text(json.dumps([dict(SPEC, path=str(p), name="wales")]))
            out = d / "out"
            (out).mkdir()
            (out / "catalog.json.sig").write_text("stale")
            import os
            os.environ.pop("CATALOG_TEST_SIGNING_KEY", None)
            self.assertEqual(tc.main(["build", "--spec", str(spec), "--release", "r", "--out", str(out)]), 0)
            cat = json.loads((out / "catalog.json").read_text())
            self.assertEqual(cat["tilesets"][0]["name"], "wales")
            self.assertEqual(cat["signing"]["status"], "UNSIGNED")
            self.assertFalse((out / "catalog.json.sig").exists())


if __name__ == "__main__":
    unittest.main()
