import tempfile,unittest,json,gzip,hashlib
from pathlib import Path
from compile_dmtiles import compile_tiles
from verify_unified_geometry import verify
ROOT=Path(__file__).resolve().parents[1]
class Unified(unittest.TestCase):
    def test_every_wells_edge_and_corrupt_feature(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);src=ROOT/"osm/wells-places-2026-11-19.osm"
            m=compile_tiles(src,p,hashlib.sha256(src.read_bytes()).hexdigest())
            report=verify(p);self.assertGreater(report["edges_checked"],500);self.assertEqual(report["unmatched_edges"],0)
            for k,info in m["tiles"].items():
                tile=json.loads(gzip.decompress((p/info["name"]).read_bytes()))
                if tile["features"]:
                    tile["features"][0][3]=[]
                    raw=gzip.compress(json.dumps(tile).encode());(p/info["name"]).write_bytes(raw)
                    info.update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest());break
            (p/"manifest.json").write_text(json.dumps(m))
            with self.assertRaises(ValueError):verify(p)
