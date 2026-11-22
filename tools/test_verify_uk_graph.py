"""Verified offline UK release restore and Android-equivalent A* smoke fixture."""
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parent))
import verify_uk_graph as v


class VerifyUkGraphTests(unittest.TestCase):
    @staticmethod
    def fixture(path):
        with sqlite3.connect(path) as db:
            db.executescript("""
                CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                INSERT INTO meta VALUES ('format','drivemate-uk-routing-v1'),
                  ('vehicle','motorcar'),('source_tag','uk-map-20261122T084645Z-9013a4487fa6');
                CREATE TABLE nodes(id INTEGER PRIMARY KEY,lat REAL,lon REAL);
                INSERT INTO nodes VALUES (1,54.990,-2.000),(2,55.005,-2.000),
                    (3,55.005,-1.999),(4,55.010,-1.999);
                CREATE TABLE edges(id INTEGER PRIMARY KEY,src INTEGER,dst INTEGER,
                    way INTEGER,metres REAL,seconds REAL,name TEXT,flags INTEGER);
                CREATE TABLE blocked(id INTEGER PRIMARY KEY);
                CREATE TABLE blocked_ways(id INTEGER PRIMARY KEY);
                INSERT INTO blocked_ways VALUES(77);
                CREATE TABLE restrictions(via INTEGER,from_way INTEGER,to_way INTEGER,policy INTEGER);
                INSERT INTO restrictions VALUES(2,10,20,1);
                CREATE TABLE places(name TEXT,lat REAL,lon REAL,kind TEXT);
                INSERT INTO places VALUES('Birmingham',52.49,-1.89,'city');
                CREATE INDEX idx_edges_from ON edges(src);
                CREATE INDEX idx_nodes_lat ON nodes(lat,lon);
                CREATE INDEX idx_turn_via_from ON restrictions(via,from_way);
            """)
            rows=((1,1,2,10),(2,2,4,20),(3,2,3,30),(4,3,4,31),(5,1,4,77))
            points={1:(54.990,-2),2:(55.005,-2),3:(55.005,-1.999),4:(55.010,-1.999)}
            for eid,a,b,way in rows:
                length=v.metres(points[a],points[b])
                db.execute("INSERT INTO edges VALUES(?,?,?,?,?,?,?,?)",
                           (eid,a,b,way,length,length/(40/3.6),"High Street",0))

    @staticmethod
    def release(db,folder):
        compressed=gzip.compress(db.read_bytes(),mtime=0)
        slices=(compressed[:len(compressed)//2],compressed[len(compressed)//2:])
        parts=[]
        for i,data in enumerate(slices):
            name=f"uk-routing.sqlite.gz.part-{i:03d}"
            (folder/name).write_bytes(data)
            parts.append({"name":name,"bytes":len(data),
                          "sha256":hashlib.sha256(data).hexdigest()})
        return {"format":v.FORMAT,"licence":"ODbL-1.0",
                "source_tag":"uk-map-20261122T084645Z-9013a4487fa6",
                "source_sha256":"a"*64,"builder_sha256":"b"*64,
                "database_bytes":db.stat().st_size,
                "database_sha256":v.sha_file(db),
                "gzip_bytes":len(compressed),
                "gzip_sha256":hashlib.sha256(compressed).hexdigest(),"parts":parts}

    def test_real_sqlite_car_route_denies_turn_and_blocked_way(self):
        with tempfile.TemporaryDirectory() as tmp:
            db=Path(tmp)/"source.db"
            self.fixture(db)
            road=v.OfflineRoads(db)
            try:
                result=road.route((54.990,-2.000),(55.010,-1.999),max_expansions=100)
                self.assertTrue(result["ok"],result)
                self.assertEqual(result["edges"],3,
                                 "Must take connected legal detour, not forbidden shortcut")
                self.assertFalse(road.route((55.010,-1.999),(54.990,-2.000),
                                            max_expansions=100)["ok"])
                self.assertTrue(road.named_places(["Birmingham"])["Birmingham"])
            finally:
                road.close()

    def test_full_gzip_part_and_sqlite_hashes_and_no_partial_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            db=folder/"fixture.sqlite"
            self.fixture(db)
            manifest=self.release(db,folder)
            v.check_manifest(manifest)
            output=folder/"installed.sqlite"
            self.assertEqual(v.restore(manifest,folder,output),db.stat().st_size)
            self.assertEqual(v.sha_file(output),manifest["database_sha256"])
            target=folder/"last-good.sqlite"
            target.write_bytes(b"last-good")
            part=folder/manifest["parts"][1]["name"]
            part.write_bytes(part.read_bytes()+b"tamper")
            with self.assertRaises(v.VerificationError):
                v.restore(manifest,folder,target)
            self.assertEqual(target.read_bytes(),b"last-good")
            self.assertFalse(target.with_suffix(".incomplete").exists())

    def test_builder_identity_and_partition_sizes_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            db=folder/"fixture.sqlite"
            self.fixture(db)
            manifest=self.release(db,folder)
            manifest["builder_sha256"]="bad"
            with self.assertRaises(v.VerificationError):
                v.check_manifest(manifest)
            manifest=self.release(db,folder)
            manifest["parts"][0]["name"]="../wrong"
            with self.assertRaises(v.VerificationError):
                v.check_manifest(manifest)


if __name__=="__main__":
    unittest.main()
