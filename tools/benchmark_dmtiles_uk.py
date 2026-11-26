#!/usr/bin/env python3
"""Engineering acceptance against actual UK tiled routing archive, offline only.
Records failures and resource bounds; no road safety claim or publication."""
import argparse,gzip,heapq,json,math,time,resource
from collections import OrderedDict
from pathlib import Path
from verify_uk_graph import sha_file,metres,OfflineRoads
from compile_dmtiles import key,digest
SAMPLES=[
 ("Sheffield to Leeds",(53.381,-1.470),(53.800,-1.549)),
 ("Sheffield to London",(53.381,-1.470),(51.507,-0.128)),
 ("Manchester to Edinburgh",(53.480,-2.242),(55.953,-3.189)),
 ("Bristol to Cardiff",(51.454,-2.588),(51.481,-3.179)),
 ("Belfast to Londonderry",(54.597,-5.930),(54.997,-7.309)),
]
# About 30 miles away from Sheffield; actual off-route distance measured.
DIVERSION=(53.96,-1.08)
# Nearest eligible road node is used; usually within metres, but a destination
# surrounded by private roads (an airport, an estate) may be further away.
SNAP_MAX_M=2000
class MissingCoverage(Exception):pass
class Archive:
    def __init__(self,manifest,archive):
        self.doc=json.loads(Path(manifest).read_text());self.tiles=self.doc["tiles"]
        self.file=Path(archive).open("rb");self.path=Path(archive)
        if self.doc["archive"]["bytes"]!=self.path.stat().st_size or self.doc["archive"]["sha256"]!=sha_file(self.path):raise ValueError("Archive integrity failure")
        self.cache=OrderedDict();self.allowed=None;self.touched=set();self.read_bytes=0;self.cache_nodes=0
        # Road hierarchy (dm_overlay.py): used automatically when the catalog has one.
        self.overlay=self.doc.get("overlay");self.ov_cache={};self.use_overlay=self.overlay is not None
        if self.overlay:
            self.ov_path=self.path.parent/self.overlay["name"]
            if self.overlay["bytes"]!=self.ov_path.stat().st_size or self.overlay["sha256"]!=sha_file(self.ov_path):raise ValueError("Overlay integrity failure")
            self.ov_file=self.ov_path.open("rb")
        # Level 2: blocks of cells crossed in one jump (dm_overlay.build_level2).
        self.overlay2=self.doc.get("overlay2") if self.overlay else None;self.ov2_cache={};self.use_level2=self.overlay2 is not None
        if self.overlay2:
            self.ov2_path=self.path.parent/self.overlay2["name"]
            if self.overlay2["bytes"]!=self.ov2_path.stat().st_size or self.overlay2["sha256"]!=sha_file(self.ov2_path):raise ValueError("Level 2 integrity failure")
            self.ov2_file=self.ov2_path.open("rb");self.block=self.overlay2["block_cells"];self.block_cells={}
            from dm_overlay import block_key
            for k in self.tiles:self.block_cells.setdefault(block_key(k,self.block),set()).add(k)
    def load_level2(self,b):
        if b in self.ov2_cache:return self.ov2_cache[b]
        m=self.overlay2["blocks"][b];self.ov2_file.seek(m["offset"]);raw=self.ov2_file.read(m["bytes"])
        if len(raw)!=m["bytes"] or digest(raw)!=m["sha256"]:raise ValueError("Corrupt level 2 "+b)
        d=json.loads(gzip.decompress(raw));d["row"]={e[0]:i for i,e in enumerate(d["entries"])}
        self.ov2_cache[b]=d;return d
    def load_overlay(self,k):
        if k in self.ov_cache:return self.ov_cache[k]
        m=self.overlay["cells"][k];self.ov_file.seek(m["offset"]);raw=self.ov_file.read(m["bytes"])
        if len(raw)!=m["bytes"] or digest(raw)!=m["sha256"]:raise ValueError("Corrupt overlay "+k)
        d=json.loads(gzip.decompress(raw));d["row"]={e[0]:i for i,e in enumerate(d["entries"])}
        self.ov_cache[k]=d;return d
    def load(self,k):
        if self.allowed is not None and k not in self.allowed:raise MissingCoverage(k)
        if k in self.cache:self.cache.move_to_end(k);return self.cache[k]
        m=self.tiles[k];self.file.seek(m["offset"]);raw=self.file.read(m["bytes"])
        if len(raw)!=m["bytes"] or digest(raw)!=m["sha256"]:raise ValueError("Corrupt tile "+k)
        self.touched.add(k);self.read_bytes+=len(raw)
        n={n[0]:n for n in json.loads(gzip.decompress(raw))["nodes"]}
        self.cache[k]=n;self.cache_nodes+=len(n)
        while len(self.cache)>1 and (len(self.cache)>128 or self.cache_nodes>1200000):
            _,old=self.cache.popitem(last=False);self.cache_nodes-=len(old)
        return n
    def clear(self):
        self.cache.clear();self.cache_nodes=0
    def near(self,p,origin):
        lat,lon=map(int,key(*p).split("_"));best=None;dist=SNAP_MAX_M
        if key(*p) not in self.tiles or self.allowed is not None and key(*p) not in self.allowed:return None
        nearby={}
        for y in range(lat-1,lat+2):
            for x in range(lon-1,lon+2):
                k=f"{y}_{x}"
                if k not in self.tiles or self.allowed is not None and k not in self.allowed:continue
                nearby[k]=self.load(k)
        incoming=set()
        if not origin:
            for nodes in nearby.values():
                for n in nodes.values():
                    for e in n[3]:
                        if e[2] in nearby:incoming.add(e[1])
        for k,nodes in nearby.items():
            for n in nodes.values():
                # Field 5 (compile_dmtiles_uk.snap_flags): 1 both, 0 neither, 2 end only, 3 start only.
                if len(n)>5 and n[5] not in ((1,3) if origin else (1,2)):continue
                if origin and not any(self.allowed is None or e[2] in self.allowed for e in n[3]):continue
                if not origin and n[0] not in incoming:continue
                d=metres(p,(n[1]/1e6,n[2]/1e6))
                if d<dist:best=(k,n);dist=d
        return best
    def route(self,start,finish,max_expansions,max_seconds):
        if self.use_overlay:return self.route_overlay(start,finish,max_expansions,max_seconds)
        return self.route_flat(start,finish,max_expansions,max_seconds)
    def route_overlay(self,start,finish,max_expansions,max_seconds):
        """A* that searches road by road only in the start and end cells and
        crosses every other cell by one precomputed exact jump. Same turn
        rules and costs as route_flat, so the same route cost."""
        from dm_overlay import state_rules,unpack_cell,block_key
        began=time.monotonic();self.touched=set();self.read_bytes=0
        a=self.near(start,True);b=self.near(finish,False)
        if not a or not b:return {"ok":False,"reason":"No nearby eligible directed road node"}
        ak,an=a;bk,bn=b;detail={ak,bk}
        goal=(bn[1]/1e6,bn[2]/1e6);global_rules=self.doc["global_rules"]
        vmax=min(160,self.doc.get("max_speed_kph",160))
        def h(lat,lon):return metres((lat,lon),goal)*3.6/vmax
        # Level 2 is used for every block except those holding the start or end
        # cell (and, offline, blocks not fully downloaded); those use level 1.
        level2=self.use_level2
        hot={block_key(ak,self.block),block_key(bk,self.block)} if level2 else set()
        def jumps_block(cell):
            if not level2:return None
            bl=block_key(cell,self.block)
            if bl in hot:return None
            if self.allowed is not None and not self.block_cells[bl]<=self.allowed:return None
            return bl
        # state: (f, g, edge, cell, node, prev_node, way). An edge whose cell is
        # a detail cell is searched road by road; otherwise it is a level-1
        # entry of that cell, or a level-2 entry of that cell's block.
        q=[(h(an[1]/1e6,an[2]/1e6),0.0,0,ak,an[0],0,0)]
        best={0:0.0};parent={};kind={};expanded=0
        while q and expanded<max_expansions and time.monotonic()-began<max_seconds:
            _,g,eid,k,nid,prev,way=heapq.heappop(q)
            if g>best.get(eid,math.inf)+1e-7:continue
            bl=None if k in detail else jumps_block(k)
            if bl is not None:
                ov=self.load_level2(bl);row=ov["cost"][ov["row"][eid]];expanded+=1
                for j,c in enumerate(row):
                    if c<0:continue
                    x=ov["exits"][j];edge,src,dst,dest,newway,lat,lon=x
                    if self.allowed is not None and dest not in self.allowed:continue
                    cost=g+c/1000
                    if cost+1e-7>=best.get(edge,math.inf):continue
                    best[edge]=cost;parent[edge]=eid;kind[edge]=("o2",bl)
                    heapq.heappush(q,(cost+h(lat/1e6,lon/1e6),cost,edge,dest,dst,src,newway))
                continue
            if k in detail:
                n=self.load(k)[nid]
                if nid==bn[0] and eid!=0:
                    return self._overlay_result(eid,g,parent,kind,ak,an,expanded,began,unpack_cell)
                expanded+=1
                rules=state_rules(global_rules,n,way)
                for edge,to,dest,newway,mm,ms in n[3]:
                    if self.allowed is not None and dest not in self.allowed:continue
                    if eid and not OfflineRoads.turn_allowed(prev,to,newway,rules):continue
                    cost=g+ms/1000
                    if cost+1e-7>=best.get(edge,math.inf):continue
                    if dest in detail:
                        t=self.load(dest).get(to)
                        if t is None:raise ValueError("Broken edge")
                        lat,lon=t[1],t[2]
                    else:
                        ov=self.load_overlay(dest);e=ov["entries"][ov["row"][edge]];lat,lon=e[4],e[5]
                    best[edge]=cost;parent[edge]=eid;kind[edge]=("d",k,nid,newway,mm)
                    heapq.heappush(q,(cost+h(lat/1e6,lon/1e6),cost,edge,dest,to,nid,newway))
            else:
                ov=self.load_overlay(k);row=ov["cost"][ov["row"][eid]];expanded+=1
                for j,c in enumerate(row):
                    if c<0:continue
                    x=ov["exits"][j];edge,src,dst,dest,newway,lat,lon=x
                    if self.allowed is not None and dest not in self.allowed:continue
                    cost=g+c/1000
                    if cost+1e-7>=best.get(edge,math.inf):continue
                    best[edge]=cost;parent[edge]=eid;kind[edge]=("o",k)
                    heapq.heappush(q,(cost+h(lat/1e6,lon/1e6),cost,edge,dest,dst,src,newway))
        return {"ok":False,"reason":"Disconnected or resource bound","expanded":expanded,"elapsed_seconds":round(time.monotonic()-began,2),"cells_read":len(self.touched),"read_bytes":self.read_bytes}
    def _overlay_result(self,eid,g,parent,kind,ak,an,expanded,began,unpack_cell):
        """Walk back from the goal, expanding each overlay jump into its roads."""
        chain=[]
        while eid:chain.append(eid);eid=parent[eid]
        chain.reverse();path=[(ak,an[1]/1e6,an[2]/1e6)];ways=[];dist=0;prev_edge=0
        global_rules=self.doc["global_rules"]
        for edge in chain:
            kd=kind[edge]
            if kd[0]=="d":
                _,k,src,way,mm=kd
                n=self.load(k)[src];rec=next(e for e in n[3] if e[0]==edge)
                t=self.load(rec[2])[rec[1]];path.append((rec[2],t[1]/1e6,t[2]/1e6));ways.append(way);dist+=mm
            else:
                if kd[0]=="o2":  # block jump -> its level-1 jumps
                    from dm_overlay import region_jumps
                    ov2=self.load_level2(kd[1]);en=ov2["entries"][ov2["row"][prev_edge]]
                    hops=region_jumps(self.load_overlay,self.block_cells[kd[1]],en[0],en[6],edge)
                else:
                    hops=[(kd[1],prev_edge,edge)]
                for k,e_in,e_out in hops:  # level-1 jump -> its roads
                    ov=self.load_overlay(k);en=ov["entries"][ov["row"][e_in]]
                    for r in unpack_cell(self.load(k),k,(en[0],en[1],en[2],en[3]),e_out,global_rules):
                        _,to,dest,way,mm,_,_=r;t=self.load(dest)[to]
                        path.append((dest,t[1]/1e6,t[2]/1e6));ways.append(way);dist+=mm
            prev_edge=edge
        return {"ok":True,"distance_km":round(dist/1e6,3),"seconds":round(g,2),"expanded":expanded,"elapsed_seconds":round(time.monotonic()-began,2),"path":path,"ways":ways,"cells_read":len(self.touched),"read_bytes":self.read_bytes,"rss_kib":resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    def route_flat(self,start,finish,max_expansions,max_seconds):
        began=time.monotonic();self.touched=set();self.read_bytes=0
        a=self.near(start,True);b=self.near(finish,False)
        if not a or not b:return {"ok":False,"reason":"No nearby eligible directed road node"}
        ak,an=a;bk,bn=b
        # No path is ever created across a missing tile; offline search is limited
        # to verified selected cells. Turn rules are the existing importer policy.
        q=[(0.0,0.0,0,ak,an[0],0,0,0.0)]
        best={0:0.0};parent={};points={0:(ak,an[1]/1e6,an[2]/1e6)};wayof={};expanded=0
        goal=(bn[1]/1e6,bn[2]/1e6);global_rules=self.doc["global_rules"]
        # Graph's own top speed keeps the estimate a true lower bound; 160 for older catalogs.
        vmax=min(160,self.doc.get("max_speed_kph",160))
        reverse={}
        if all("crossing_ms" in t for t in self.tiles.values()):
            for k,t in self.tiles.items():
                for dest,ms in t["crossing_ms"].items():reverse.setdefault(dest,[]).append((k,ms))
        lower={bk:0};coarse=[(0,bk)]
        while coarse:
            cost,k=heapq.heappop(coarse)
            if cost!=lower[k]:continue
            for src,ms in reverse.get(k,[]):
                v=cost+ms
                if v<lower.get(src,math.inf):lower[src]=v;heapq.heappush(coarse,(v,src))
        while q and expanded<max_expansions and time.monotonic()-began<max_seconds:
            _,g,eid,k,nid,prev,way,dist=heapq.heappop(q)
            if g>best.get(eid,math.inf)+1e-7:continue
            n=self.load(k)[nid]
            if nid==bn[0] and eid!=0:
                path=[];ways=[];current=eid
                while current:
                    path.append(points[current]);ways.append(wayof[current]);current=parent[current]
                path.append(points[0]);path.reverse();ways.reverse()
                return {"ok":True,"distance_km":round(dist/1000,3),"seconds":round(g,2),"expanded":expanded,"elapsed_seconds":round(time.monotonic()-began,2),"path":path,"ways":ways,"cells_read":len(self.touched),"read_bytes":self.read_bytes,"rss_kib":resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
            expanded+=1
            rules=global_rules.get(str(way),[])+[[r[1],r[2]] for r in n[4] if r[0]==way]
            for edge,to,dest,newway,mm,ms in n[3]:
                if self.allowed is not None and dest not in self.allowed:continue
                if eid and not OfflineRoads.turn_allowed(prev,to,newway,rules):continue
                cost=g+ms/1000
                if cost+1e-7>=best.get(edge,math.inf):continue
                t=self.load(dest).get(to)
                if t is None:raise ValueError("Broken edge")
                h=max(metres((t[1]/1e6,t[2]/1e6),goal)*3.6/vmax,lower.get(dest,0)/1000)
                best[edge]=cost;parent[edge]=eid;points[edge]=(dest,t[1]/1e6,t[2]/1e6);wayof[edge]=newway
                heapq.heappush(q,(cost+h,cost,edge,dest,to,nid,newway,dist+mm/1000))
            if len(best)>max_expansions*3:break
        return {"ok":False,"reason":"Disconnected or resource bound","expanded":expanded,"elapsed_seconds":round(time.monotonic()-began,2),"cells_read":len(self.touched),"read_bytes":self.read_bytes}
def coverage(tiles,path,radius,budget):
    must={p[0] for p in path};used=sum(tiles[k]["bytes"] for k in must)
    if used>budget:raise ValueError("Mandatory route exceeds cache budget")
    # sample path roughly every 1 km; add conservative tile and sample margin.
    anchors=[];last=None
    for _,lat,lon in path:
        if last is None or metres(last,(lat,lon))>=1000:
            last=(lat,lon);anchors.append(last)
    anchors.append(path[-1][1:]);rank=[]
    for k,m in tiles.items():
        if k in must:continue
        y,x=map(int,k.split("_"));p=((y+.5)*.05,(x+.5)*.05)
        d=min(metres(p,a) for a in anchors)
        if d<=radius+6000:rank.append((d,k))
    all_fit=True
    for _,k in sorted(rank):
        size=tiles[k]["bytes"]
        if used+size>budget:all_fit=False;continue
        must.add(k);used+=size
    return must,used,all_fit
def main():
    p=argparse.ArgumentParser();p.add_argument("--manifest",required=True);p.add_argument("--archive",required=True);p.add_argument("--report",required=True);p.add_argument("--expansions",type=int,default=350000);p.add_argument("--seconds",type=int,default=90);a=p.parse_args()
    ar=Archive(a.manifest,a.archive);results=[];diversion=None
    for name,start,end in SAMPLES:
        ar.allowed=None;ar.clear();r=ar.route(start,end,a.expansions,a.seconds)
        path=r.pop("path",None);r.pop("ways",None)
        if name=="Sheffield to London" and path:
            selected,used,complete=coverage(ar.tiles,path,48300,500_000_000)
            # actual minimum distance from deviation to original sampled vertices.
            offset=min(metres(DIVERSION,(lat,lon)) for _,lat,lon in path)
            ar.allowed=selected;ar.clear()
            diversion=ar.route(DIVERSION,end,a.expansions,a.seconds);diversion.pop("path",None);diversion.pop("ways",None)
            diversion.update({"distance_from_original_vertex_km":round(offset/1000,2),"cached_cells":len(selected),"cache_bytes":used,"requested_radius_fits_catalog_budget":complete,"no_network":True})
        r["name"]=name;results.append(r);print(json.dumps(r),flush=True)
    ar.file.close();passed=all(r["ok"] for r in results) and bool(diversion and diversion["ok"] and diversion["distance_from_original_vertex_km"]>=48.3)
    report={"road_validated":False,"platform":"Python engineering mirror, not Android","source_sha256":ar.doc["source_sha256"],"samples":results,"diversion":diversion,"passed":passed}
    Path(a.report).write_text(json.dumps(report,indent=2)+"\n");print(json.dumps({"passed":passed,"diversion":diversion}));return 0 if passed else 2
if __name__=="__main__":raise SystemExit(main())
