#!/usr/bin/env python3
"""Repartition verified nationwide DriveMate graph into range-addressable cells.
Routing and named places only; no claim of full cartographic features.
"""
import argparse, gzip, hashlib, json, sqlite3, time
from array import array
from pathlib import Path
from compile_dmtiles import key,packed,digest
from verify_uk_graph import check_manifest,sha_file
CELL=50000
# Road networks smaller than this (mutually reachable nodes) are not used to
# snap a journey's start or end: a car park or a road fragment cut off by a
# barrier or a data gap would otherwise make the whole journey fail.
MIN_SNAP_COMPONENT=50
def strong_components(n, src, dst):
    """Kosaraju strongly connected components over 0..n-1, iterative, using
    compact arrays so it scales to the UK graph. Returns (component, sizes)."""
    def csr(a, b):
        start=array("q",[0])*(n+1)
        for x in a:start[x+1]+=1
        for i in range(n):start[i+1]+=start[i]
        adj=array("q",[0])*len(a);pos=array("q",start)
        for x,y in zip(a,b):adj[pos[x]]=y;pos[x]+=1
        return start,adj
    fs,fa=csr(src,dst);rs,ra=csr(dst,src)
    seen=bytearray(n);order=array("q");nxt=array("q",fs[:n])
    for root in range(n):
        if seen[root]:continue
        seen[root]=1;stack=[root]
        while stack:
            v=stack[-1];i=nxt[v]
            if i<fs[v+1]:
                nxt[v]=i+1;w=fa[i]
                if not seen[w]:seen[w]=1;stack.append(w)
            else:
                stack.pop();order.append(v)
    comp=array("q",[-1])*n;sizes=[]
    for root in reversed(order):
        if comp[root]!=-1:continue
        c=len(sizes);comp[root]=c;stack=[root];size=0
        while stack:
            v=stack.pop();size+=1
            for i in range(rs[v],rs[v+1]):
                w=ra[i]
                if comp[w]==-1:comp[w]=c;stack.append(w)
        sizes.append(size)
    return comp,sizes
def snappable_nodes(db):
    """bytearray indexed by cell_nodes.rowid-1: 1 if the node is in a network of
    at least MIN_SNAP_COMPONENT mutually reachable nodes."""
    n=db.execute("SELECT MAX(rowid) FROM cell_nodes").fetchone()[0] or 0
    src=array("q");dst=array("q")
    for a,b in db.execute("""SELECT s.rowid-1,d.rowid-1 FROM edges e
        JOIN cell_nodes s ON s.id=e.src JOIN cell_nodes d ON d.id=e.dst
        WHERE NOT EXISTS(SELECT 1 FROM blocked_ways b WHERE b.id=e.way)"""):
        src.append(a);dst.append(b)
    comp,sizes=strong_components(n,src,dst)
    return bytearray(1 if sizes[c]>=MIN_SNAP_COMPONENT else 0 for c in comp)
def compile_graph(dbpath, manifest, out, pilot=False):
    check_manifest(manifest)
    if sha_file(dbpath)!=manifest["database_sha256"]:raise ValueError("Unverified graph")
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(str(dbpath));db.execute("PRAGMA temp_store=FILE");db.execute("PRAGMA cache_size=-131072")
    meta=dict(db.execute("SELECT key,value FROM meta"))
    if meta.get("source_sha256")!=manifest["source_sha256"] or meta.get("source_tag")!=manifest["source_tag"]:raise ValueError("Graph provenance mismatch")
    db.create_function("cell",2,key,deterministic=True)
    db.executescript("""
      CREATE TEMP TABLE cell_nodes AS SELECT id,cell(lat,lon) AS k,lat,lon FROM nodes WHERE id NOT IN (SELECT id FROM blocked);
      CREATE UNIQUE INDEX temp.cn_id ON cell_nodes(id);
      CREATE INDEX temp.cn_cell ON cell_nodes(k);
      CREATE TEMP TABLE cell_places AS SELECT cell(lat,lon) AS k,name,lat,lon,kind FROM places;
      CREATE INDEX temp.cp_cell ON cell_places(k);
    """)
    cells=[r[0] for r in db.execute("SELECT k FROM cell_nodes UNION SELECT k FROM cell_places ORDER BY k")]
    snap=snappable_nodes(db)
    catalog={};global_rules={};counts={"nodes":0,"edges":0,"cross_cell_edges":0,"places":0,"unsnappable_nodes":snap.count(0)}
    for frm,to,policy in db.execute("SELECT from_way,to_way,policy FROM restrictions WHERE via=0"):
        global_rules.setdefault(str(frm),[]).append([to,policy])
    arc=out/"routing.dma";offset=0;started=time.monotonic()
    with arc.open("wb") as output:
        for i,k in enumerate(cells):
            # Field 5: 1 = may snap a journey start/end here (see MIN_SNAP_COMPONENT).
            records={nid:[nid,round(lat*1e6),round(lon*1e6),[],[],snap[row-1]] for nid,lat,lon,row in db.execute("SELECT id,lat,lon,rowid FROM cell_nodes WHERE k=? ORDER BY id",(k,))}
            if len(records)>80000:raise ValueError("Cell exceeds Android node bound; subdivide "+k)
            neighbors=set();edge_count=0;street={}
            for eid,src,dst,other,way,m,s,name in db.execute("""
              SELECT e.id,e.src,e.dst,d.k,e.way,e.metres,e.seconds,e.name
              FROM cell_nodes n INDEXED BY cn_cell CROSS JOIN edges e INDEXED BY idx_edges_from ON e.src=n.id
              JOIN cell_nodes d ON d.id=e.dst
              WHERE n.k=? AND NOT EXISTS(SELECT 1 FROM blocked_ways b WHERE b.id=e.way)
              """,(k,)):
                records[src][3].append([eid,dst,other,way,round(m*1000),round(s*1000)]);edge_count+=1
                if other!=k:neighbors.add(other);counts["cross_cell_edges"]+=1
                if name:street.setdefault(name,records[src][1:3])
            for frm,to,policy,via in db.execute("SELECT r.from_way,r.to_way,r.policy,r.via FROM cell_nodes n CROSS JOIN restrictions r INDEXED BY idx_turn_via_from ON r.via=n.id WHERE n.k=?",(k,)):
                records[via][4].append([frm,to,policy])
            places=[[n,round(lat*1e6),round(lon*1e6),kind] for n,lat,lon,kind in db.execute("SELECT name,lat,lon,kind FROM cell_places WHERE k=?",(k,))]
            places.extend([n,*v,"street"] for n,v in sorted(street.items()))
            raw=packed({"nodes":list(records.values()),"places":places,"features":[]})
            blob=gzip.compress(raw,compresslevel=6,mtime=0)
            if len(raw)>24000000 or len(blob)>8000000:raise ValueError("Cell exceeds reader bounds "+k)
            output.write(blob);catalog[k]={"name":k+".dmt.gz","bytes":len(blob),"sha256":digest(blob),"offset":offset,"nodes":len(records),"edges":edge_count,"neighbors":sorted(neighbors)}
            offset+=len(blob);counts["nodes"]+=len(records);counts["edges"]+=edge_count;counts["places"]+=len(places)
            if i%500==0:print("Compiled",i,"/",len(cells),"cells",round(time.monotonic()-started,1),"s",flush=True)
    if not pilot and (counts["nodes"]<1000000 or counts["edges"]<2000000):raise ValueError("Not UK scale")
    for k,info in catalog.items():
        if any(n not in catalog for n in info["neighbors"]):raise ValueError("Broken cell link "+k)
    # Fastest edge in the graph (rounded up): A* divides straight-line distance by
    # this, so it must never be below any real edge speed or routes stop being optimal.
    fastest=db.execute("SELECT MAX(metres/seconds) FROM edges WHERE seconds>0").fetchone()[0] or 0
    doc={"format":"drivemate-tiles-v1","max_speed_kph":int(fastest*3.6)+1,"scope":"pilot" if pilot else "uk-routing-only","source_sha256":manifest["source_sha256"],"source_tag":manifest["source_tag"],"license":"ODbL-1.0","attribution":"© OpenStreetMap contributors","cell_microdegrees":CELL,"global_rules":global_rules,"tiles":catalog,"archive":{"name":arc.name,"bytes":offset,"sha256":sha_file(arc)},"road_validated":False,"stats":counts}
    (out/"manifest.json").write_bytes(packed(doc));db.close()
    print(json.dumps({"cells":len(catalog),"archive_bytes":offset,"manifest_bytes":(out/"manifest.json").stat().st_size,"stats":counts}),flush=True)
    return doc
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--db",required=True);p.add_argument("--manifest",required=True);p.add_argument("--out",required=True)
    p.add_argument("--overlay",action="store_true",help="also build the road hierarchy, levels 1 and 2 (dm_overlay.py)");a=p.parse_args()
    compile_graph(a.db,json.loads(Path(a.manifest).read_text()),a.out)
    if a.overlay:
        from dm_overlay import build_overlay,build_level2
        print(json.dumps(build_overlay(a.out)["overlay"]["stats"]),flush=True)
        print(json.dumps(build_level2(a.out)["overlay2"]["stats"]),flush=True)
