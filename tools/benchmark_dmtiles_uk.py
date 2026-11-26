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
class MissingCoverage(Exception):pass
class Archive:
    def __init__(self,manifest,archive):
        self.doc=json.loads(Path(manifest).read_text());self.tiles=self.doc["tiles"]
        self.file=Path(archive).open("rb");self.path=Path(archive)
        if self.doc["archive"]["bytes"]!=self.path.stat().st_size or self.doc["archive"]["sha256"]!=sha_file(self.path):raise ValueError("Archive integrity failure")
        self.cache=OrderedDict();self.allowed=None;self.touched=set();self.read_bytes=0;self.cache_nodes=0
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
        lat,lon=map(int,key(*p).split("_"));best=None;dist=350
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
                if len(n)>5 and not n[5]:continue  # tiny isolated road network
                if origin and not any(self.allowed is None or e[2] in self.allowed for e in n[3]):continue
                if not origin and n[0] not in incoming:continue
                d=metres(p,(n[1]/1e6,n[2]/1e6))
                if d<dist:best=(k,n);dist=d
        return best
    def route(self,start,finish,max_expansions,max_seconds):
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
