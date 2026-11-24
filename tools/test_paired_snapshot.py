import unittest
from unittest.mock import patch
from paired_snapshot import pair
class PairTest(unittest.TestCase):
    def test_fail_closed_and_match(self):
        g={"source_tag":"uk-test","source_sha256":"a"*64,"tile_extract_sha256":"b"*64,"tile_extract_bytes":1024}
        r={"format":"drivemate-map-intelligence-v1","scope":"uk","licence":"ODbL-1.0","source_tag":"uk-test","source_sha256":"c"*64,"database_sha256":"d"*64,"database_bytes":100}
        p={"passed":True,"samples":[{"passed":True} for _ in range(5)]}
        with patch("paired_snapshot.inspect_manifest"):
            with self.assertRaisesRegex(ValueError,"Source mismatch"):pair(g,r,p,"e"*64)
            r["source_sha256"]=g["source_sha256"]
            self.assertFalse(pair(g,r,p,"e"*64)["road_validated"])
            p["samples"][0]["passed"]=False
            with self.assertRaisesRegex(ValueError,"probes"):pair(g,r,p,"e"*64)
if __name__=="__main__":unittest.main()
