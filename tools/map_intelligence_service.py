#!/usr/bin/env python3
"""Local read-only API for a verified DriveMate map-intelligence SQLite pack.

A candidate service, not a public endpoint. No routing decisions, writes,
TomTom data, survey notes or user tracking. Production needs HTTPS/auth/rate limits.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

FORMAT="drivemate-map-intelligence-v1"
MAX_RESULTS=50

def verify_pack(db,report):
    meta=json.loads(Path(report).read_text())
    if meta.get("format")!=FORMAT or meta.get("licence")!="ODbL-1.0" or meta.get("scope") not in ("pilot","uk"):
        raise ValueError("Unsupported intelligence manifest")
    with Path(db).open("rb") as f:
        digest=hashlib.file_digest(f,"sha256").hexdigest()
    if Path(db).stat().st_size!=meta.get("database_bytes") or digest!=meta.get("database_sha256"):
        raise ValueError("Intelligence database checksum mismatch")
    store=Store(db)
    actual=store.metadata()
    for key in ("format","source_tag","source_sha256","scope","licence"):
        if actual.get(key)!=meta.get(key):raise ValueError("Manifest metadata mismatch: "+key)
    return store

class Store:
    def __init__(self,db):
        self.uri=Path(db).resolve().as_uri()+"?mode=ro"
    def connect(self):
        c=sqlite3.connect(self.uri,uri=True,timeout=2)
        c.row_factory=sqlite3.Row
        c.execute("PRAGMA query_only=ON")
        return c
    def metadata(self):
        with self.connect() as c:return dict(c.execute("SELECT key,value FROM meta"))
    @staticmethod
    def feature(row,details=False):
        if row is None:return None
        keys=("osm_type","osm_id","osm_version","category","name","ref","lat","lon","geometry_complete")
        out={k:row[k] for k in keys}
        if details:
            out["tags"]=json.loads(row["tags_json"])
            out["geometry"]=json.loads(row["geometry_json"]) if row["geometry_json"] else None
            out["members"]=json.loads(row["members_json"]) if row["members_json"] else None
        return out
    def get(self,kind,oid):
        if kind not in ("n","w","r") or not 0<oid<2**63:raise ValueError("Invalid OSM identity")
        with self.connect() as c:
            return self.feature(c.execute("SELECT * FROM feature WHERE osm_type=? AND osm_id=?",(kind,oid)).fetchone(),True)
    def nearby(self,lat,lon,radius=100,limit=25):
        if not all(map(math.isfinite,(lat,lon,radius))) or not 49<=lat<=61 or not -9<=lon<=3 or not 1<=radius<=1000 or not 1<=limit<=MAX_RESULTS:
            raise ValueError("Invalid UK query bounds")
        dy=radius/111000;dx=radius/(111000*math.cos(math.radians(lat)))
        with self.connect() as c:
            rows=c.execute("""SELECT f.* FROM bounds b JOIN feature f ON f.fid=b.fid
                WHERE b.min_lat<=? AND b.max_lat>=? AND b.min_lon<=? AND b.max_lon>=?
                ORDER BY f.fid LIMIT ?""",(lat+dy,lat-dy,lon+dx,lon-dx,limit+1)).fetchall()
        return {"features":[self.feature(r) for r in rows[:limit]],"truncated":len(rows)>limit,
                "note":"Bounding-box candidates only; not snapped roads, exact distances or lane recommendations."}
    def search(self,q,limit=20):
        q=q.strip()
        if not 2<=len(q)<=100 or not 1<=limit<=MAX_RESULTS:raise ValueError("Invalid search")
        prefix=q.replace("\\","\\\\").replace("%","\\%").replace("_","\\_")+"%"
        with self.connect() as c:
            rows=c.execute("""SELECT * FROM feature WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE
                ORDER BY name COLLATE NOCASE,fid LIMIT ?""",(prefix,limit+1)).fetchall()
        return {"features":[self.feature(r) for r in rows[:limit]],"truncated":len(rows)>limit,
                "note":"Mapped name prefix search; not complete address/postcode geocoding."}

def dispatch(store,path):
    url=urlsplit(path);q=parse_qs(url.query,strict_parsing=True) if url.query else {}
    def one(key,default=None):
        a=q.get(key)
        if a is None:
            if default is None:raise ValueError("Missing "+key)
            return default
        if len(a)!=1:raise ValueError("Duplicate "+key)
        return a[0]
    if url.path=="/v1/meta":return 200,store.metadata()
    if url.path=="/v1/feature":
        item=store.get(one("type"),int(one("id")))
        return (200,item) if item is not None else (404,{"error":"Object not found"})
    if url.path=="/v1/nearby":return 200,store.nearby(float(one("lat")),float(one("lon")),float(one("radius","100")),int(one("limit","25")))
    if url.path=="/v1/search":return 200,store.search(one("q"),int(one("limit","20")))
    return 404,{"error":"Unknown endpoint"}

def serve(store,port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass # Do not log GPS coordinates or search terms.
        def do_GET(self):
            try:
                if len(self.path)>2048:raise ValueError("Request too long")
                status,body=dispatch(store,self.path)
            except (ValueError,OverflowError):status,body=400,{"error":"Invalid query"}
            except sqlite3.Error:status,body=503,{"error":"Database unavailable"}
            raw=json.dumps(body,ensure_ascii=False,separators=(",",":")).encode("utf8")
            if len(raw)>4_000_000:status,raw=413,b'{"error":"Object too large"}'
            self.send_response(status);self.send_header("Content-Type","application/json; charset=utf-8")
            self.send_header("Cache-Control","no-store");self.send_header("Content-Length",str(len(raw)));self.end_headers()
            self.wfile.write(raw)
        def do_POST(self):self.send_error(405)
        def do_PUT(self):self.send_error(405)
        def do_DELETE(self):self.send_error(405)
    server=ThreadingHTTPServer(("127.0.0.1",port),Handler)
    print("Read-only map intelligence on localhost",port,flush=True)
    server.serve_forever()
def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db",required=True);p.add_argument("--report",required=True);p.add_argument("--port",type=int,default=8010)
    a=p.parse_args();serve(verify_pack(a.db,a.report),a.port)
if __name__=="__main__":main()
