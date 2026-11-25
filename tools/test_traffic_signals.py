import tempfile,struct,unittest
from pathlib import Path
from build_traffic_signals import encode
class TrafficSignals(unittest.TestCase):
    def test_only_source_signals_sorted_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);src=p/"x.osm";out=p/"signals.bin"
            src.write_text('<osm><node id="1" lat="53.5" lon="-2.2"><tag k="highway" v="traffic_signals"/></node><node id="2" lat="53.4" lon="-2.1"><tag k="highway" v="traffic_signals"/></node><node id="3" lat="53.6" lon="-2.3"><tag k="highway" v="crossing"/></node><node id="4" lat="53.5" lon="-2.2"><tag k="highway" v="traffic_signals"/></node></osm>')
            self.assertEqual(encode(src,"a"*64,out),2)
            b=out.read_bytes();self.assertEqual(struct.unpack(">4s32sI",b[:40]),(b"DMS1",bytes.fromhex("a"*64),2))
            self.assertEqual(struct.unpack(">iiii",b[40:]),(534000000,-21000000,535000000,-22000000))
if __name__=="__main__":unittest.main()
