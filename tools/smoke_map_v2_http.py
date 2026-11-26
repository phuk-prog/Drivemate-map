#!/usr/bin/env python3
"""Verify a running matched-source gateway. Tests geometry presence, not physical roads."""
import argparse,json,math,re
from urllib.parse import urlencode,urlsplit
from urllib.request import Request,build_opener,HTTPRedirectHandler
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
PROBES=[("London",-.128,51.507),("Birmingham",-1.899,52.480),("Stockport",-2.159,53.410),("Cardiff",-3.179,51.481),("Edinburgh",-3.188,55.953),("Belfast",-5.930,54.597)]
def fetch(root,path):
    with build_opener(NoRedirect()).open(Request(root+path,headers={"Accept":"application/json"}),timeout=30) as r:
        raw=r.read(8000001)
        if len(raw)>8000000:raise ValueError("Oversized response")
        return json.loads(raw)
def verify(root,reader=fetch):
    graph=reader(root,"/v1/graph-source");meta=reader(root,"/v1/meta")
    sha=graph.get("source_sha256","")
    if not re.fullmatch("[a-f0-9]{64}",sha) or meta.get("source_sha256")!=sha or meta.get("scope")!="uk":raise ValueError("Graph and intelligence mismatch")
    results=[]
    for name,x,y in PROBES:
        bounds=[x-.0015,y-.001,x+.0015,y+.001]
        q=urlencode({"bbox":",".join(map(str,bounds)),"source":sha})
        d=reader(root,"/v2/roads?"+q)
        if d.get("format")!="drivemate-map-v2" or d.get("source_sha256")!=sha or d.get("coordinate_scale")!=10000000 or d.get("bounds")!=bounds:raise ValueError("Geometry source/bounds mismatch: "+name)
        ways=d.get("features",[]);points=d.get("points",[])
        if len(ways)>6000 or len(points)>6000:raise ValueError("Unbounded result")
        roads=buildings=vertices=0
        for row in ways:
            oid,tags,coords,refs=row
            if len(coords)!=len(refs) or len(coords)<2:raise ValueError("Missing node identity")
            for c in coords:
                if len(c)!=2 or any(type(v) is not int for v in c) or not(-900000000<=c[0]<=900000000 and -1800000000<=c[1]<=1800000000):raise ValueError("Invalid coordinate")
            vertices+=len(coords)
            roads+=bool(tags.get("highway"))
            buildings+=bool(tags.get("building") and tags["building"]!="no" and coords[0]==coords[-1])
        if not roads or not buildings or vertices>100000:raise ValueError("Missing roads/buildings: "+name)
        results.append({"place":name,"roads":roads,"building_ways":buildings,"vertices":vertices,"mapped_points":len(points)})
    return {"source_sha256":sha,"probes":results,"road_validated":False}
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument("--root",default="http://127.0.0.1:8011");a=p.parse_args()
    u=urlsplit(a.root)
    if u.username or u.password or u.query or u.fragment or not (u.scheme=="https" or u.scheme=="http" and u.hostname=="127.0.0.1"):raise SystemExit("Use loopback HTTP or approved HTTPS gateway")
    print(json.dumps(verify(a.root.rstrip("/")),indent=2))
if __name__=="__main__":main()
