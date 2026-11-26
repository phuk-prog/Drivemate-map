#!/usr/bin/env python3
"""Verify every directed routing edge against the same original rendered way and node IDs."""
import argparse,gzip,json,hashlib
from pathlib import Path
def verify(folder):
    folder=Path(folder);m=json.loads((folder/"manifest.json").read_text())
    if m.get("geometry_contract")!="way-node-segments-v1":raise ValueError("No shared geometry contract")
    nodes={};ways={}
    for key,info in m["tiles"].items():
        raw=(folder/info["name"]).read_bytes()
        if len(raw)!=info["bytes"] or hashlib.sha256(raw).hexdigest()!=info["sha256"]:raise ValueError("Tile integrity")
        t=json.loads(gzip.decompress(raw))
        for n in t["nodes"]:
            if n[0] in nodes:raise ValueError("Duplicate node")
            nodes[n[0]]=(key,n)
        for f in t["features"]:
            if len(f)!=4 or len(f[2])!=len(f[3]):raise ValueError("Missing way node identities")
            if f[0] in ways and ways[f[0]]!=f:raise ValueError("Conflicting way across cells")
            ways[f[0]]=f
    index={}
    for way,tags,coords,refs in ways.values():
        for a,b,ca,cb in zip(refs,refs[1:],coords,coords[1:]):
            for x,y,p,q in ((a,b,ca,cb),(b,a,cb,ca)):
                k=(way,x,y)
                if k in index and index[k]!=(p,q):raise ValueError("Conflicting segment coordinates")
                index[k]=(p,q)
    edges=0;cross=0;classes={};names=set()
    for src,(cell,n) in nodes.items():
        for e in n[3]:
            dst=e[1];way=e[3];other,b=nodes[dst]
            if e[2]!=other or index.get((way,src,dst))!=(n[1:3],b[1:3]):raise ValueError("Unmatched directed edge")
            edges+=1;cross+=other!=cell
            tags=ways[way][1];kind=tags.get("highway","ferry");classes[kind]=classes.get(kind,0)+1
            if tags.get("name"):names.add(tags["name"])
    if edges<500:raise ValueError("Insufficient road geometry")
    return {"source_sha256":m["source_sha256"],"edges_checked":edges,"unmatched_edges":0,"max_shared_coordinate_deviation_metres":0,"nodes":len(nodes),"features":len(ways),"cross_cell_edges":cross,"road_classes":classes,"named_roads":len(names),"stockport_named_road_presence":{n:n.casefold() in {x.casefold() for x in names} for n in ("Yew Street","Hollywood Way","Brinksway","St Davids Road")},"scope":"Exact internal geometry identity, not road-validated driving"}
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("folder");p.add_argument("--report",required=True);a=p.parse_args()
    result=verify(a.folder);Path(a.report).write_text(json.dumps(result,indent=2)+"\n");print(json.dumps(result))
