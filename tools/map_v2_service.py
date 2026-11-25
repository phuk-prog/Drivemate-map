#!/usr/bin/env python3
"""Bounded read-only exact geometry candidate. Deploy behind trusted HTTPS separately."""
import argparse,json,math,sqlite3
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlsplit,parse_qs
from build_map_v2 import FORMAT,SCALE
from build_uk_roads import digest
def open_db(path):
    c=sqlite3.connect(Path(path).resolve().as_uri()+"?mode=ro",uri=True)
    c.execute("PRAGMA query_only=ON");return c
def verify(path,manifest):
    m=json.loads(Path(manifest).read_text())
    if m.get("format")!=FORMAT or m.get("database_bytes")!=Path(path).stat().st_size or digest(path)!=m.get("database_sha256"):raise ValueError("Database verification failed")
    with open_db(path) as c:
        meta=dict(c.execute("SELECT key,value FROM meta"))
        if meta.get("source_sha256")!=m.get("source_sha256") or meta.get("map_v2_format")!=FORMAT:raise ValueError("Source mismatch")
    return m
def roads(path,bounds,expected_sha):
    west,south,east,north=bounds
    if not all(map(math.isfinite,bounds)) or not (-9<=west<east<=3 and 49<=south<north<=61 and east-west<=.12 and north-south<=.12):raise ValueError("Invalid bounded UK region")
    with open_db(path) as c:
        meta=dict(c.execute("SELECT key,value FROM meta"))
        if meta["source_sha256"]!=expected_sha:raise ValueError("Graph source mismatch")
        rows=c.execute("""SELECT w.id,w.tags,w.coords,w.refs FROM render_bounds b JOIN render_way w ON w.id=b.id
            WHERE b.min_lon<=? AND b.max_lon>=? AND b.min_lat<=? AND b.max_lat>=? ORDER BY w.id LIMIT 6001""",(east,west,north,south)).fetchall()
        if len(rows)>6000:raise ValueError("Region too dense; request smaller bounds")
        features=[];count=0
        for oid,tags,coords,refs in rows:
            cs=json.loads(coords);count+=len(cs)
            if count>100000:raise ValueError("Region too large")
            # Keep E7 in API; client explicitly decodes scale.
            features.append([oid,json.loads(tags),cs,json.loads(refs)])
        # Return actual source nodes, not fabricated centroids. Bounded independently.
        points=c.execute("""SELECT id,lat,lon,tags FROM mapped_point
            WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? ORDER BY id LIMIT 6001""",
            (math.floor(south*SCALE),math.ceil(north*SCALE),math.floor(west*SCALE),math.ceil(east*SCALE))).fetchall()
        if len(points)>6000:raise ValueError("Point region too dense; request smaller bounds")
        return {"format":FORMAT,"source_sha256":expected_sha,"coordinate_scale":SCALE,"features":features,"points":[[oid,y,x,json.loads(tags)] for oid,y,x,tags in points],"bounds":bounds}
def serve(path,manifest,port):
    verify(path,manifest)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            try:
                u=urlsplit(self.path)
                if len(self.path)>2048 or u.path!="/v2/roads":raise ValueError("Unknown request")
                q=parse_qs(u.query,strict_parsing=True)
                if set(q)!={"bbox","source"} or any(len(v)!=1 for v in q.values()):raise ValueError("Invalid query")
                bounds=list(map(float,q["bbox"][0].split(",")))
                if len(bounds)!=4:raise ValueError("Invalid bounds")
                result=roads(path,bounds,q["source"][0]);status=200
            except (ValueError,KeyError):result={"error":"Invalid bounds, size or source"};status=400
            except sqlite3.Error:result={"error":"Database unavailable"};status=503
            raw=json.dumps(result,separators=(",",":")).encode()
            if len(raw)>8000000:status,raw=413,b'{"error":"Region too large"}'
            self.send_response(status);self.send_header("Content-Type","application/json");self.send_header("Cache-Control","no-store");self.send_header("Content-Length",str(len(raw)));self.end_headers();self.wfile.write(raw)
    ThreadingHTTPServer(("127.0.0.1",port),Handler).serve_forever()
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--db",required=True);p.add_argument("--manifest",required=True);p.add_argument("--port",type=int,default=8011);a=p.parse_args();serve(a.db,a.manifest,a.port)
