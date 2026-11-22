"""Fail-closed UK Valhalla HTTP service acceptance, without network fixtures."""
import io
import json
import unittest
from types import SimpleNamespace

from smoke_valhalla_http import verify_http
from test_probe_valhalla_graph import response


class SmokeValhallaHttpTest(unittest.TestCase):
    def test_all_sample_routes_have_proper_manoeuvres(self):
        seen=[]
        def opener(req,timeout):
            self.assertEqual(req.method,"POST")
            self.assertEqual(req.get_header("Content-type"),"application/json")
            self.assertEqual(timeout,45)
            seen.append(json.loads(req.data))
            return io.BytesIO(json.dumps(response()).encode())
        result=verify_http("http://127.0.0.1:8002/route",opener=opener)
        self.assertTrue(result["passed"])
        self.assertEqual(len(seen),5)
        self.assertTrue(all(x["costing"]=="auto" for x in seen))

    def test_any_missing_route_fails_entire_deployment(self):
        calls=[]
        def opener(req,timeout):
            calls.append(1)
            if len(calls)==3:
                return io.BytesIO(b'{"error":"No route"}')
            return io.BytesIO(json.dumps(response()).encode())
        result=verify_http("https://routing.example.test/route",opener=opener)
        self.assertFalse(result["passed"])
        self.assertEqual(len(calls),5)

    def test_refuses_credentials_http_public_or_wrong_path(self):
        for endpoint in ("http://routing.example.test/route",
                         "https://a:b@host.example/route",
                         "http://127.0.0.1:8002/search",
                         "file:///tmp/route",
                         "https://routing.example.test/route?token=bad"):
            with self.subTest(endpoint=endpoint),self.assertRaises(ValueError):
                verify_http(endpoint,opener=lambda *a,**kw: None)


if __name__=="__main__":
    unittest.main()
