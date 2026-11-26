import tempfile,hashlib,json,gzip,unittest
from pathlib import Path
from compile_dmtiles import compile_tiles
ROOT=Path(__file__).resolve().parents[1]
class SearchTests(unittest.TestCase):
    def test_address_fields_without_claiming_coverage(self):
        source=(ROOT/"osm/wells-places-2026-11-19.osm").read_text()
        # Synthetic isolated address, not a real-world address claim.
        source=source.replace("</osm>",'<node id="999999999999" lat="51.209" lon="-2.647" version="1"><tag k="addr:housenumber" v="10"/><tag k="addr:street" v="Fixture Road"/><tag k="addr:postcode" v="ZZ0 0ZZ"/></node></osm>')
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);raw=source.encode();(p/"fixture.osm").write_bytes(raw)
            doc=compile_tiles(p/"fixture.osm",p/"out",hashlib.sha256(raw).hexdigest())
            entries=[]
            for meta in doc["tiles"].values():entries.extend(json.loads(gzip.decompress((p/"out"/meta["name"]).read_bytes()))["places"])
            self.assertTrue(any(x[0]=="10 Fixture Road, ZZ0 0ZZ" and x[4]=="ZZ0 0ZZ" for x in entries))
if __name__=="__main__":unittest.main()
