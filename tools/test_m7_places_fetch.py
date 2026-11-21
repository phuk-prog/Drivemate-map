"""Independent, network-free checks for the M7 sourced-place extractor."""
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_osm_extract import query, inventory


class SourcePlaceFetchTest(unittest.TestCase):
    BOX = [51.198, -2.668, 51.222, -2.622]

    def test_legacy_roads_query_is_unmodified(self):
        old = query(self.BOX)
        self.assertIn('way["highway"~', old)
        self.assertIn('relation["type"="restriction"]', old)
        self.assertNotIn('addr:housenumber', old)
        self.assertNotIn('["amenity"]', old)

    def test_place_query_is_bounded_and_additive(self):
        got = query(self.BOX, include_places=True)
        self.assertTrue(got.startswith('[out:xml][timeout:180];('))
        self.assertIn('(._;>;);out body;', got)
        self.assertIn('relation["type"="restriction"]', got)
        for kind in ("node", "way"):
            self.assertIn(kind + '["addr:housenumber"](51.198000,-2.668000,51.222000,-2.622000);', got)
            for key in ("amenity", "shop", "tourism", "leisure", "historic", "office"):
                self.assertIn(kind + '["name"]["' + key + '"]', got)

    def test_bad_bounds_rejected_before_network(self):
        with self.assertRaises(SystemExit):
            query([51.0, -3.0, 52.0, -2.0], True)
        with self.assertRaises(SystemExit):
            query([52, -2, 51, -3], True)

    def test_inventory_reports_only_explicit_source_tags(self):
        xml = ET.fromstring("""<osm>
          <node id="1"><tag k="addr:housenumber" v="23"/><tag k="addr:street" v="High Street"/><tag k="addr:postcode" v="BA5 1AA"/></node>
          <node id="2"><tag k="name" v="Example Hall"/><tag k="amenity" v="townhall"/></node>
          <node id="3"><tag k="addr:housenumber" v="3"/></node>
          <way id="4"><tag k="name" v="Example Hall"/><tag k="historic" v="yes"/></way>
        </osm>""")
        got = inventory(xml)
        self.assertEqual(got["node"], {"explicit_addresses": 1, "named_pois": 1, "postcode_tags": 1})
        self.assertEqual(got["way"], {"explicit_addresses": 0, "named_pois": 1, "postcode_tags": 0})


if __name__ == "__main__":
    unittest.main()
