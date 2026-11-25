import tempfile,unittest,sqlite3
from pathlib import Path
from build_map_v2 import Unified
from map_v2_service import roads
class MapV2(unittest.TestCase):
    def test_exact_bends_cross_cell_and_raw_tags(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/"map.sqlite";b=Unified(p)
            b.way(12,{"highway":"residential","name":"Bend","lanes":"2","maxspeed":"30 mph"},[(1,53.049,-2.6),(2,53.051,-2.601),(3,53.052,-2.6)])
            b.node(8,53.05,-2.6,{"addr:housenumber":"4","addr:street":"Bend","addr:postcode":"AB1 2CD"})
            s=b.finish_v2("fixture","a"*64,1)
            self.assertEqual(s["verified_directed_edges"],4)
            self.assertEqual(s["mapped_points"],1)
            r=roads(p,[-2.61,53.04,-2.59,53.06],"a"*64)
            self.assertEqual(r["features"][0][2],[[530490000,-26000000],[530510000,-26010000],[530520000,-26000000]])
            self.assertEqual(r["features"][0][1]["maxspeed"],"30 mph")
            self.assertEqual(r["points"][0][0],8)
            self.assertEqual(r["points"][0][3]["addr:housenumber"],"4")
            with self.assertRaises(ValueError):roads(p,[-2.61,53.04,-2.59,53.06],"b"*64)
    def test_graph_without_matching_geometry_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            b=Unified(Path(folder)/"map.sqlite")
            b.way(12,{"highway":"residential"},[(1,53.049,-2.6),(2,53.051,-2.601)])
            b.db.execute("DELETE FROM render_segment")
            with self.assertRaises(ValueError):b.finish_v2("fixture","a"*64,1)
if __name__=="__main__":unittest.main()
