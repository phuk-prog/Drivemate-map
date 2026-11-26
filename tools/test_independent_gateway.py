import unittest
from independent_gateway import request_allowed,load_pair,load_geometry,geometry_query
from unittest.mock import patch,Mock
import tempfile
from pathlib import Path
import json
class GatewayTest(unittest.TestCase):
    def test_allowlist(self):
        for method,path in [("POST","/route"),("POST","/trace_attributes"),("GET","/v1/ways?ids=1,2"),("GET","/v1/graph-source"),("GET","/v2/roads?bbox=-2,53,-1.99,53.01&source=abc")]:
            self.assertTrue(request_allowed(method,path))
        for method,path in [("GET","http://example.org/route"),("GET","//example.org/v1/meta"),("POST","/v1/ways"),("POST","/route?x=1"),("GET","/admin"),("DELETE","/v1/feature")]:
            self.assertFalse(request_allowed(method,path))
    def test_pair_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);archive=p/"tiles.tar";archive.write_bytes(b"abc");manifest=p/"manifest.json"
            manifest.write_text(json.dumps({"tile_extract_bytes":3,"tile_extract_sha256":"a"*64,"source_sha256":"b"*64,"source_tag":"graph"}))
            store=Mock();store.metadata.return_value={"scope":"uk","source_sha256":"c"*64,"source_tag":"graph"}
            with patch("independent_gateway.inspect_manifest"),patch("independent_gateway.sha_file",return_value="a"*64),patch("independent_gateway.verify_pack",return_value=store):
                with self.assertRaisesRegex(ValueError,"same immutable"):load_pair(manifest,archive,p/"db",p/"report")
                store.metadata.return_value={"scope":"uk","source_sha256":"b"*64,"source_tag":"graph"}
                self.assertEqual(load_pair(manifest,archive,p/"db",p/"report")[1]["source_sha256"],"b"*64)
    def test_geometry_source_and_query(self):
        source={"source_sha256":"a"*64,"source_tag":"pinned"}
        with patch("independent_gateway.verify_geometry",return_value=source):
            self.assertEqual(load_geometry(Path("db"),Path("manifest"),source),Path("db"))
            with self.assertRaises(ValueError):load_geometry(Path("db"),None,source)
            with self.assertRaises(ValueError):load_geometry(Path("db"),Path("manifest"),dict(source,source_tag="wrong"))
        self.assertEqual(geometry_query(None,source,"/v2/roads")[0],503)
        path="/v2/roads?bbox=-2,53,-1.99,53.01&source="+source["source_sha256"]
        with patch("independent_gateway.roads",return_value={"features":[]}) as reader:
            self.assertEqual(geometry_query(Path("db"),source,path),(200,{"features":[]}))
            reader.assert_called_once_with(Path("db"),[-2,53,-1.99,53.01],source["source_sha256"])
        with self.assertRaises(ValueError):geometry_query(Path("db"),source,path+"&source=bad")
        with self.assertRaises(ValueError):geometry_query(Path("db"),source,path.replace("a"*64,"b"*64))
if __name__=="__main__":unittest.main()
