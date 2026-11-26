import unittest
from urllib.parse import urlsplit,parse_qs
from smoke_map_v2_http import verify,PROBES
class DetailSmoke(unittest.TestCase):
    def test_all_six_and_fail_closed(self):
        sha="a"*64
        def read(root,path):
            if path=="/v1/graph-source":return {"source_sha256":sha}
            if path=="/v1/meta":return {"source_sha256":sha,"scope":"uk"}
            q=parse_qs(urlsplit(path).query);b=list(map(float,q["bbox"][0].split(",")))
            c=[[530000000,-20000000],[530000100,-20000100],[530000000,-20000000]]
            return {"format":"drivemate-map-v2","source_sha256":sha,"coordinate_scale":10000000,"bounds":b,"features":[[1,{"highway":"residential"},c,[1,2,1]],[2,{"building":"house"},c,[1,2,1]]],"points":[]}
        self.assertEqual(len(verify("http://127.0.0.1:8011",read)["probes"]),len(PROBES))
        def bad(root,path):
            r=read(root,path)
            if "features" in r:r["features"].pop()
            return r
        with self.assertRaises(ValueError):verify("http://127.0.0.1:8011",bad)
if __name__=="__main__":unittest.main()
