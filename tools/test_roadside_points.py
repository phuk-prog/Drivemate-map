import tempfile,struct,unittest
from pathlib import Path
from build_roadside_points import encode,kinds
class Roadside(unittest.TestCase):
    def test_explicit_only(self):
        self.assertEqual(kinds({"highway":"speed_camera"}),[1])
        self.assertEqual(kinds({"highway":"crossing","traffic_calming":"hump"}),[2,3])
        self.assertEqual(kinds({"highway":"traffic_signals"}),[4])
        self.assertEqual(kinds({"highway":"residential","traffic_calming":"yes"}),[])
    def test_binary_order_dedupe(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);src=p/"in.osm";out=p/"points.bin"
            src.write_text('<osm><node id="1" lat="53.5" lon="-2.2"><tag k="highway" v="speed_camera"/></node><node id="2" lat="53.4" lon="-2.1"><tag k="highway" v="crossing"/></node><node id="3" lat="53.5" lon="-2.2"><tag k="highway" v="speed_camera"/></node><node id="4" lat="53.6" lon="-2.3"><tag k="highway" v="residential"/></node></osm>')
            self.assertEqual(encode(src,"a"*64,out),2)
            b=out.read_bytes();self.assertEqual(struct.unpack(">4s32sI",b[:40]),(b"DMH1",bytes.fromhex("a"*64),2))
            self.assertEqual(struct.unpack(">iiBiiB",b[40:]),(534000000,-21000000,2,535000000,-22000000,1))
if __name__=="__main__":unittest.main()
