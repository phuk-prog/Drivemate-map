import unittest
from independent_gateway import request_allowed,load_pair,load_geometry
from unittest.mock import patch,Mock
import tempfile
from pathlib import Path
import json
class GatewayTest(unittest.TestCase):
    def test_allowlist(self):
        for method,path in [("POST","/route"),("POST","/trace_attributes"),("GET","/v1/ways?ids=1,2"),("GET","/v1/graph-source"),("GET","/v2/roads?bbox=-2.61,53.04,-2.59,53.06&source=a")]:
            self.assertTrue(request_allowed(method,path))
        for method,path in [("GET","http://example.org/route"),("GET","//example.org/v1/meta"),("POST","/v1/ways"),("POST","/v2/roads"),("POST","/route?x=1"),("GET","/admin"),("DELETE","/v1/feature")]:
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
    def test_geometry_optional_but_source_matched(self):
        src={"source_sha256":"a"*64,"source_tag":"exact"}
        self.assertIsNone(load_geometry(None,None,src))
        with self.assertRaises(ValueError):load_geometry(Path("db"),None,src)
        with patch("independent_gateway.verify_geometry",return_value={"source_sha256":"b"*64,"source_tag":"exact"}):
            with self.assertRaisesRegex(ValueError,"same immutable"):load_geometry(Path("db"),Path("manifest"),src)
        with patch("independent_gateway.verify_geometry",return_value={"source_sha256":"a"*64,"source_tag":"other"}):
            with self.assertRaisesRegex(ValueError,"same immutable"):load_geometry(Path("db"),Path("manifest"),src)
        with patch("independent_gateway.verify_geometry",return_value=src):
            self.assertEqual(load_geometry(Path("db"),Path("manifest"),src),Path("db").resolve())
if __name__=="__main__":unittest.main()
