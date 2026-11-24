import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from build_map_intelligence import Builder, explicit_speed, sha, build

class IntelligenceTest(unittest.TestCase):
    def test_preserves_directional_conditional_tags_and_member_order(self):
        with tempfile.TemporaryDirectory() as folder:
            db=Path(folder)/"test.sqlite"
            b=Builder(db)
            tags={"highway":"primary","name":"Test Road","lanes":"3","turn:lanes:forward":"left|through;right",
                  "maxspeed:forward":"20 mph","maxspeed:backward":"30 mph","maxspeed:conditional":"10 mph @ (school hours)",
                  "destination:lanes":"A|B","unknown:new:tag":"preserve me"}
            b.add("w",123,7,tags,[(11,53,-2),(12,53.001,-2)])
            members=[("w",123,"from"),("n",12,"via"),("w",124,"to")]
            b.add("r",5,1,{"type":"connectivity","connectivity":"1:1|2:2,3"},members=members)
            b.add("n",12,1,{"highway":"motorway_junction","ref":"4"},[(12,53.001,-2)])
            b.add("w",124,1,{"highway":"primary"},[(12,53.001,-2),(13,None,None)])
            report=b.finish("fixture","0"*64,"pilot")
            with sqlite3.connect(db) as c:
                self.assertEqual(json.loads(c.execute("SELECT tags_json FROM feature WHERE osm_type='w' AND osm_id=123").fetchone()[0]),tags)
                self.assertEqual(json.loads(c.execute("SELECT members_json FROM feature WHERE osm_type='r'").fetchone()[0]),[list(x) for x in members])
                self.assertEqual(c.execute("SELECT geometry_complete FROM feature WHERE osm_type='w' AND osm_id=124").fetchone()[0],0)
                self.assertEqual(c.execute("SELECT count(*) FROM bounds WHERE min_lat<=53.001 AND max_lat>=53.001").fetchone()[0],3)
            self.assertEqual(report["road_classes"]["primary"]["tag_presence_by_way_pct"]["turn_lanes"],50)
            self.assertEqual(report["road_classes"]["primary"]["counts"]["numeric_speed_tag"],1)
            self.assertFalse(report["road_validated"])
    def test_missing_and_symbolic_speed_not_numeric(self):
        self.assertFalse(explicit_speed({"maxspeed":"GB:nsl_single"}))
        self.assertFalse(explicit_speed({"maxspeed:conditional":"20 mph @ (Mo-Fr)"}))
        self.assertTrue(explicit_speed({"maxspeed:backward":"30 mph"}))
    def test_hash_mismatch_fails_before_import(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"test.osm";path.write_text("not an OSM file")
            with self.assertRaisesRegex(ValueError,"SHA256"):build(path,"0"*64,"fixture",Path(folder)/"out","pilot")
if __name__=="__main__":unittest.main()
