import gzip,hashlib,json,tempfile,unittest
from pathlib import Path
from compile_dmtiles import compile_tiles,key
ROOT=Path(__file__).resolve().parents[1]
SHA="8cde16000a69096b62f7a75598fb892c2d8eea34b8f2237278a785ddf125ce26"
class Tiles(unittest.TestCase):
    def test_real_map_integrity_and_cross_tile_links(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);m=compile_tiles(ROOT/"osm/wells-places-2026-11-19.osm",root,SHA)
            self.assertGreater(len(m["tiles"]),1)
            nodes={};edges=0;cross=0
            for k,info in m["tiles"].items():
                blob=(root/info["name"]).read_bytes()
                self.assertEqual(hashlib.sha256(blob).hexdigest(),info["sha256"])
                self.assertEqual(len(blob),info["bytes"])
                tile=json.loads(gzip.decompress(blob))
                for n in tile["nodes"]:
                    self.assertEqual(key(n[1]/1e6,n[2]/1e6),k)
                    self.assertNotIn(n[0],nodes)
                    nodes[n[0]]=(k,n)
            for k,n in nodes.values():
                for e in n[3]:
                    edges+=1
                    self.assertEqual(nodes[e[1]][0],e[2])
                    if e[2]!=k:cross+=1
            self.assertGreater(edges,500);self.assertGreater(cross,0)
            self.assertFalse(m["road_validated"])
    def test_bad_source_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):compile_tiles(ROOT/"osm/wells-places-2026-11-19.osm",d,"0"*64)
if __name__=="__main__":unittest.main()
