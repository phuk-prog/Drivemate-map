"""Network-free nationwide road-graph builder regression checks."""
import gzip
import hashlib
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_uk_roads as uk


class UkGraphTests(unittest.TestCase):
    def test_names_preserved_for_every_uk_place_and_road(self):
        self.assertEqual(uk.road_name("Birmingham"), "Birmingham")
        self.assertEqual(uk.road_name("  St John's   Road  "), "St John's Road")
        self.assertEqual(uk.road_name("A58\nNew Road|Old Road"), "A58 New Road Old Road")
        self.assertEqual(uk.road_name("M" * 200), "M" * 80)

    def test_access_and_implied_oneway(self):
        self.assertIsNone(uk.access({"motorcar":"unknown"}))
        self.assertFalse(uk.access({"access":"private"}))
        self.assertTrue(uk.access({"access":"private","motorcar":"yes"}))
        self.assertEqual(uk.direction({"highway":"motorway_link"}), "F")
        self.assertIsNone(uk.direction({"oneway":"alternating"}))

    def test_exact_osm_ids_directions_restrictions_and_release_parts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            db=root/"graph.sqlite"
            b=uk.Builder(db)
            p1=(10, 52.00,-1.00)
            p2=(11, 52.001,-1.00)
            p3=(12, 52.002,-1.00)
            p4=(13, 52.001,-0.999)
            b.node(11,p2[1],p2[2],{"place":"town","name":"Testville"})
            b.way(100,{"highway":"residential","name":"First Road"},[p1,p2,p3])
            b.way(101,{"highway":"primary","oneway":"yes","name":"Second Road"},[p2,p4])
            b.way(102,{"highway":"service","access":"private"},[p2,p4])
            b.way(103,{"highway":"residential","motorcar:conditional":"no @ (Mo-Fr 10:00-12:00)"},[p1,p4])
            b.turn({"type":"restriction","restriction":"no_right_turn"},
                   [("from","w",100),("via","n",11),("to","w",101)])
            b.turn({"type":"restriction","restriction":"unexpected_kind"},
                   [("from","w",101),("via","n",13),("to","w",100)])
            stats=b.finish("uk-map-20261122T084645Z-9013a4487fa6","0"*64,min_edges=1)
            self.assertEqual(stats["edges"],5)
            with sqlite3.connect(db) as conn:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM restrictions").fetchone()[0],1)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM blocked_ways").fetchone()[0],1)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM places").fetchone()[0],1)
                self.assertEqual(conn.execute("SELECT name FROM places").fetchone()[0],"Testville")
                names={row[0] for row in conn.execute("SELECT DISTINCT name FROM edges")}
                self.assertEqual(names,{"First Road","Second Road"})
                self.assertEqual(conn.execute("SELECT value FROM meta WHERE key='format'").fetchone()[0],uk.FORMAT)
            output=root/"out"
            manifest=uk.publish(db,output,"uk-map-20261122T084645Z-9013a4487fa6",
                                "0"*64,stats,part_bytes=100)
            self.assertGreater(len(manifest["parts"]),1)
            self.assertEqual(manifest["builder_sha256"],uk.digest(Path(uk.__file__)))
            parts=b"".join((output/p["name"]).read_bytes() for p in manifest["parts"])
            self.assertEqual(hashlib.sha256(parts).hexdigest(),manifest["gzip_sha256"])
            self.assertEqual(hashlib.sha256(gzip.decompress(parts)).hexdigest(),
                             manifest["database_sha256"])
            self.assertFalse((output/"uk-routing.sqlite.gz").exists())

    def test_non_car_conditional_tags_do_not_remove_a_road(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=uk.Builder(Path(tmp)/"graph.sqlite")
            p1=(20, 52.000,-1.00)
            p2=(21, 52.001,-1.00)
            p3=(22, 52.002,-1.00)
            # A lorry-weight rule says nothing about cars: this road must stay routable.
            b.way(200,{"highway":"residential","name":"Lorry Rule Road","maxweightrating:goods:conditional":"none @ destination"},[p1,p2])
            # A car rule makes the road unroutable (kept conservative).
            b.way(201,{"highway":"residential","name":"Car Rule Road","motor_vehicle:conditional":"no @ (Mo-Fr 07:00-09:00)"},[p2,p3])
            stats=b.finish("uk-map-20261122T084645Z-9013a4487fa6","0"*64,min_edges=1)
            self.assertEqual(stats["edges"],2)
            self.assertEqual(stats["excluded_conditional_access_or_direction"],1)

    def test_car_conditional_keys(self):
        self.assertTrue(uk.car_conditional({"access:conditional":"no @ (Mo-Fr)"}))
        self.assertTrue(uk.car_conditional({"motor_vehicle:forward:conditional":"no @ (Sa)"}))
        self.assertTrue(uk.car_conditional({"oneway:conditional":"yes @ (07:00-09:00)"}))
        self.assertTrue(uk.car_conditional({"motorcar:conditional":"no @ wet"}))
        self.assertFalse(uk.car_conditional({"maxweightrating:goods:conditional":"none @ destination"}))
        self.assertFalse(uk.car_conditional({"maxweightrating:hgv:conditional":"none @ destination"}))
        self.assertFalse(uk.car_conditional({"maxweight:conditional":"7.5 @ (Mo-Su)"}))
        self.assertFalse(uk.car_conditional({"bicycle:conditional":"no @ (Mo-Fr)"}))
        self.assertFalse(uk.car_conditional({"maxspeed:conditional":"20 mph @ (school)"}))
        self.assertFalse(uk.car_conditional({"highway":"residential"}))

    def test_unknown_road_access_refuses_routing(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=uk.Builder(Path(tmp)/"graph.db")
            refs=[(1,53,-2),(2,53.001,-2)]
            b.way(1,{"highway":"residential","oneway":"reversible"},refs)
            b.way(2,{"highway":"residential","motorcar":"restricted"},refs)
            self.assertEqual(b.next_edge,0)
            with self.assertRaises(ValueError):
                b.finish("test","0"*64)
            b.db.close()


if __name__=="__main__":
    unittest.main()
