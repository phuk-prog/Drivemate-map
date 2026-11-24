import tempfile
import unittest
from pathlib import Path
import json
from build_map_intelligence import Builder,sha
from map_intelligence_service import verify_pack,dispatch
class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();root=Path(self.tmp.name);self.db=root/"test.sqlite";self.report=root/"coverage.json"
        b=Builder(self.db)
        b.add("w",10,2,{"highway":"primary","name":"Test Road","maxspeed":"20 mph","turn:lanes":"left|through"},[(1,53,-2),(2,53.001,-2)])
        b.add("n",11,1,{"amenity":"fuel","name":"Test Fuel"},[(11,53,-2)])
        r=b.finish("fixture","0"*64,"pilot");r.update(database_sha256=sha(self.db),database_bytes=self.db.stat().st_size)
        self.report.write_text(json.dumps(r));self.store=verify_pack(self.db,self.report)
    def tearDown(self):self.tmp.cleanup()
    def test_exact_identity_preserves_tags(self):
        status,item=dispatch(self.store,"/v1/feature?type=w&id=10")
        self.assertEqual(status,200);self.assertEqual(item["tags"]["maxspeed"],"20 mph");self.assertEqual(item["osm_version"],2)
        self.assertEqual(dispatch(self.store,"/v1/feature?type=n&id=10")[0],404)
    def test_bounded_nearby_and_search(self):
        self.assertTrue(self.store.nearby(53,-2,100,1)["truncated"])
        self.assertEqual(len(self.store.search("Test")["features"]),2)
        self.assertEqual(self.store.search("%_")["features"],[])
        with self.assertRaises(ValueError):self.store.nearby(53,-2,10000)
    def test_read_only_and_checksum(self):
        import sqlite3
        with self.store.connect() as c:
            with self.assertRaises(sqlite3.OperationalError):c.execute("DELETE FROM feature")
        self.report.write_text(self.report.read_text().replace(sha(self.db),"0"*64))
        with self.assertRaises(ValueError):verify_pack(self.db,self.report)
if __name__=="__main__":unittest.main()
