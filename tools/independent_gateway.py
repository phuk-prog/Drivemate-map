#!/usr/bin/env python3
"""Private loopback gateway for one verified UK graph + intelligence snapshot.

Public exposure requires a separately configured TLS/authentication/rate-limiting
reverse proxy. No public listener, user logs, open proxy or writes.
"""
import argparse
import hashlib
import hmac
import os
import json
import re
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import BoundedSemaphore
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
from map_intelligence_service import verify_pack, dispatch
from restore_uk_valhalla import inspect_manifest, sha_file

MAX_BODY=2_000_000
MAX_RESPONSE=8_000_000
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
def load_pair(manifest_path,archive,db,report):
    graph=json.loads(Path(manifest_path).read_text())
    inspect_manifest(graph)
    if Path(archive).stat().st_size!=graph["tile_extract_bytes"] or sha_file(archive)!=graph["tile_extract_sha256"]:
        raise ValueError("Graph archive integrity mismatch")
    store=verify_pack(db,report);meta=store.metadata()
    if meta.get("scope")!="uk" or graph["source_tag"]!=meta.get("source_tag") or graph["source_sha256"]!=meta.get("source_sha256"):
        raise ValueError("Graph and map index must share the same immutable UK source")
    return store,{"source_sha256":graph["source_sha256"],"source_tag":graph["source_tag"],"graph_sha256":graph["tile_extract_sha256"],"road_validated":False}
def request_allowed(method,path):
    u=urlsplit(path)
    if u.scheme or u.netloc or u.fragment or len(path)>2048:return False
    if method=="POST":return u.path in ("/route","/trace_attributes") and not u.query
    return method=="GET" and u.path in ("/v1/meta","/v1/graph-source","/v1/feature","/v1/ways","/v1/nearby","/v1/search")
def proxy_token_valid(value):
    return isinstance(value,str) and re.fullmatch(r"[A-Za-z0-9_-]{32,128}",value) is not None

def proxy_authorized(headers,token):
    if not proxy_token_valid(token):return False
    supplied=headers.get_all("X-DriveMate-Proxy-Token",[])
    return len(supplied)==1 and proxy_token_valid(supplied[0]) and hmac.compare_digest(supplied[0],token)

def serve(store,source,port,route_port,proxy_token=None,development=False):
    if not development and not proxy_token_valid(proxy_token):
        raise ValueError("A private DRIVEMATE_PROXY_TOKEN is required")
    if development and proxy_token:
        raise ValueError("Choose authenticated gateway or explicit local development")

    slots=BoundedSemaphore(8);opener=build_opener(NoRedirect())
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def setup(self):
            super().setup();self.connection.settimeout(25)
        def response(self,status,raw):
            self.send_response(status)
            self.send_header("Content-Type","application/json; charset=utf-8")
            self.send_header("Cache-Control","no-store")
            self.send_header("Content-Length",str(len(raw)));self.end_headers();self.wfile.write(raw)
        def send_json(self,status,body):self.response(status,json.dumps(body,ensure_ascii=False,separators=(",",":")).encode())
        def handle_api(self,method):
            if not development and not proxy_authorized(self.headers,proxy_token):
                self.send_json(401,{"error":"Unauthorised"});return
            if not request_allowed(method,self.path):self.send_json(404,{"error":"Unsupported endpoint"});return
            if not slots.acquire(blocking=False):self.send_json(503,{"error":"Service busy"});return
            try:
                if method=="GET":
                    if self.path=="/v1/graph-source":self.send_json(200,source);return
                    status,body=dispatch(store,self.path)
                    raw=json.dumps(body,ensure_ascii=False,separators=(",",":")).encode()
                    if len(raw)>MAX_RESPONSE:self.send_json(413,{"error":"Response too large"})
                    else:self.response(status,raw)
                    return
                if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Type","").split(";")[0].strip()!="application/json":
                    self.send_json(400,{"error":"JSON with content length required"});return
                size=int(self.headers.get("Content-Length","0"))
                if not 0<size<=MAX_BODY:self.send_json(413,{"error":"Invalid request size"});return
                raw=self.rfile.read(size);body=json.loads(raw)
                if not isinstance(body,dict) or body.get("costing")!="auto":
                    self.send_json(400,{"error":"Only car navigation supported"});return
                if self.path=="/route" and (not isinstance(body.get("locations"),list) or len(body["locations"])!=2):
                    self.send_json(400,{"error":"Exactly two route locations required"});return
                req=Request("http://127.0.0.1:"+str(route_port)+self.path,data=raw,headers={"Content-Type":"application/json"},method="POST")
                with opener.open(req,timeout=20) as res:
                    payload=res.read(MAX_RESPONSE+1)
                    if len(payload)>MAX_RESPONSE:raise ValueError("Oversized upstream response")
                    json.loads(payload)
                    self.response(200,payload)
            except HTTPError as e:self.send_json(422 if 400<=e.code<500 else 503,{"error":"Routing request unavailable"})
            except (ValueError,TypeError,OverflowError):self.send_json(400,{"error":"Invalid query"})
            except (OSError,URLError):self.send_json(503,{"error":"Routing unavailable"})
            finally:slots.release()
        def do_GET(self):self.handle_api("GET")
        def do_POST(self):self.handle_api("POST")
    ThreadingHTTPServer(("127.0.0.1",port),Handler).serve_forever()
def main():
    p=argparse.ArgumentParser(description=__doc__)
    for k in ("graph-manifest","graph-archive","db","report"):p.add_argument("--"+k,required=True,type=Path)
    p.add_argument("--port",type=int,default=8011);p.add_argument("--route-port",type=int,default=8002)
    p.add_argument("--local-development-no-auth",action="store_true",help="Loopback-only testing; never expose behind a proxy")
    a=p.parse_args()
    token=os.environ.get("DRIVEMATE_PROXY_TOKEN")
    if not a.local_development_no_auth and not proxy_token_valid(token):p.error("Configure private DRIVEMATE_PROXY_TOKEN")
    store,source=load_pair(a.graph_manifest,a.graph_archive,a.db,a.report)
    print("Verified graph/index source:",source["source_tag"],"; loopback only; NOT ROAD VALIDATED",flush=True)
    serve(store,source,a.port,a.route_port,token,a.local_development_no_auth)
if __name__=="__main__":main()
