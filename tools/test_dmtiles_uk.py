import tempfile,json,gzip,hashlib,unittest
from pathlib import Path
from build_uk_roads import Builder,publish
from compile_dmtiles_uk import compile_graph
class NationwideFormat(unittest.TestCase):
    def test_archive_and_cross_tile_connectivity(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);db=p/"roads.sqlite";b=Builder(db)
            b.way(1,{"highway":"residential","name":"Cross Road"},[(1,51.049,-2.6),(2,51.051,-2.6),(3,51.052,-2.6)])
            tag="uk-map-20261122T084645Z-9013a4487fa6";sha="a"*64
            stats=b.finish(tag,sha,min_edges=1)
            m=publish(db,p/"release",tag,sha,stats,part_bytes=10000)
            doc=compile_graph(db,m,p/"tiles",pilot=True)
            self.assertEqual(doc["stats"]["edges"],4);self.assertEqual(doc["stats"]["cross_cell_edges"],2)
            self.assertEqual(len(doc["tiles"]),2)
            arc=(p/"tiles/routing.dma").read_bytes()
            for k,v in doc["tiles"].items():
                raw=arc[v["offset"]:v["offset"]+v["bytes"]]
                self.assertEqual(hashlib.sha256(raw).hexdigest(),v["sha256"])
                self.assertTrue(json.loads(gzip.decompress(raw))["nodes"])
if __name__=="__main__":unittest.main()
