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

    def test_only_car_conditional_tags_exclude_a_road(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=uk.Builder(Path(tmp)/"graph.db")
            refs=[(1,53,-2),(2,53.001,-2)]
            # Lorry weight limit, bus lane and parking rules do not affect cars.
            b.way(1,{"highway":"tertiary","maxweightrating:hgv:conditional":"none @ destination"},refs)
            b.way(2,{"highway":"residential","maxweight:conditional":"7.5 @ (06:00-18:00)"},refs)
            b.way(3,{"highway":"primary","lanes:psv:forward:conditional":"1 @ (Mo-Fr 07:00-10:00)"},refs)
            for i,k in enumerate(("access","motor_vehicle","vehicle","motorcar","oneway"),start=10):
                b.way(i,{"highway":"residential",k+":conditional":"no @ (Mo-Fr 08:00-09:00)"},refs)
            self.assertEqual(b.stats["ways"],3)
            self.assertEqual(b.stats["excluded_conditional_access_or_direction"],5)
            b.db.close()

    def test_unmarked_gate_passable_with_penalty_private_gate_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            db=Path(tmp)/"graph.db";b=uk.Builder(db)
            b.node(2,53.001,-2,{"barrier":"gate"})
            b.node(4,53.003,-2,{"barrier":"gate","access":"private"})
            b.node(5,53.004,-2,{"barrier":"lift_gate","motor_vehicle":"yes"})
            b.way(1,{"highway":"residential"},[(1,53,-2),(2,53.001,-2),(3,53.002,-2),(4,53.003,-2),(5,53.004,-2)])
            b.finish("uk-map-20261122T084645Z-9013a4487fa6","0"*64,min_edges=1)
            with sqlite3.connect(db) as conn:
                self.assertEqual({r[0] for r in conn.execute("SELECT id FROM blocked")},{4})
                plain=conn.execute("SELECT seconds FROM edges WHERE src=2 AND dst=3").fetchone()[0]
                into_gate=conn.execute("SELECT seconds FROM edges WHERE src=1 AND dst=2").fetchone()[0]
                self.assertAlmostEqual(into_gate-plain,uk.GATE_PENALTY_S,delta=0.5)
                self.assertGreater(conn.execute("SELECT seconds FROM edges WHERE src=4 AND dst=5").fetchone()[0],uk.GATE_PENALTY_S)

    def test_lit_unsigned_road_is_30_mph_restricted_road(self):
        self.assertAlmostEqual(uk.kph({"highway":"tertiary","lit":"yes"}),48.28,places=1)
        self.assertEqual(uk.kph({"highway":"tertiary"}),uk.SPEED["tertiary"])
        self.assertEqual(uk.kph({"highway":"residential","lit":"yes"}),32)  # already slower
        self.assertAlmostEqual(uk.kph({"highway":"primary","lit":"yes","maxspeed":"40 mph"}),64.37,places=1)
        self.assertEqual(uk.kph({"highway":"motorway","lit":"yes"}),112)

    def test_unsigned_roads_slower_in_built_up_areas_and_roundabouts(self):
        with tempfile.TemporaryDirectory() as tmp:
            db=Path(tmp)/"graph.db";b=uk.Builder(db)
            # Dense grid of streets around 53.0,-2.0 makes that square built up.
            nid=100
            for i in range(12):
                row=[(nid+j,53.0+0.0008*i,-2.0+0.0009*j) for j in range(12)];nid+=12
                b.way(1000+i,{"highway":"residential"},row)
            for j in range(12):
                b.way(2000+j,{"highway":"residential"},[(100+i*12+j,53.0+0.0008*i,-2.0+0.0009*j) for i in range(12)])
            b.way(1,{"highway":"tertiary"},[(1,53.004,-1.9995),(2,53.0045,-1.9995)])            # built up, unsigned
            b.way(2,{"highway":"tertiary","maxspeed":"40 mph"},[(3,53.004,-1.999),(4,53.0045,-1.999)])  # signed: kept
            b.way(3,{"highway":"tertiary"},[(5,53.5,-2.5),(6,53.5005,-2.5)])                   # countryside
            b.way(4,{"highway":"primary","junction":"roundabout","maxspeed":"30 mph"},[(7,53.6,-2.5),(8,53.6005,-2.5)])
            b.finish("uk-map-20261122T084645Z-9013a4487fa6","0"*64,min_edges=1)
            with sqlite3.connect(db) as conn:
                kph=lambda w:conn.execute("SELECT metres/seconds*3.6 FROM edges WHERE way=? LIMIT 1",(w,)).fetchone()[0]
                self.assertAlmostEqual(kph(1),uk.URBAN_SPEED["tertiary"],places=3)
                self.assertAlmostEqual(kph(2),64.37,places=1)
                self.assertAlmostEqual(kph(3),uk.SPEED["tertiary"],places=3)
                self.assertAlmostEqual(kph(4),uk.ROUNDABOUT_KPH,places=3)

    def test_traffic_signal_adds_delay(self):
        old=uk.SIGNAL_PENALTY_S;uk.SIGNAL_PENALTY_S=10;self.addCleanup(setattr,uk,"SIGNAL_PENALTY_S",old)
        with tempfile.TemporaryDirectory() as tmp:
            db=Path(tmp)/"graph.db";b=uk.Builder(db)
            b.node(2,53.001,-2,{"highway":"traffic_signals"})
            b.way(1,{"highway":"primary"},[(1,53,-2),(2,53.001,-2),(3,53.002,-2)])
            b.finish("uk-map-20261122T084645Z-9013a4487fa6","0"*64,min_edges=1)
            with sqlite3.connect(db) as conn:
                into=conn.execute("SELECT seconds FROM edges WHERE src=1 AND dst=2").fetchone()[0]
                out=conn.execute("SELECT seconds FROM edges WHERE src=2 AND dst=3").fetchone()[0]
                self.assertAlmostEqual(into-out,10,delta=0.5)

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
