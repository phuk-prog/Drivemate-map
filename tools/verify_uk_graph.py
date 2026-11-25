#!/usr/bin/env python3
"""Offline engineering QA against an *actual released* nationwide UK road graph.

Restores the ordered, SHA-256-verified GitHub Release parts, verifies the raw
SQLite digest, and runs Android-equivalent bounded car A* across England,
Scotland, Wales and Northern Ireland. Does NOT certify road safety.
"""
import argparse
from functools import lru_cache
import gzip
import hashlib
import heapq
import json
import math
from pathlib import Path
import shutil
import sqlite3
import sys
import time

FORMAT = "drivemate-uk-routing-v1"
MAX_EXPANSIONS = 350_000
SNAP_METRES = 350.0
SEARCH_WEIGHT = 2.2  # bounded approximate travel-time search, not a fastest-route proof
ATTRIBUTION = "© OpenStreetMap contributors, ODbL 1.0"

# Named real-world points are only representative anchors for coverage checks.
# Neither these points nor source OSM names assert a safe driving manoeuvre.
SAMPLES = (
    ("England: Birmingham to Coventry", (52.486, -1.890), (52.408, -1.510)),
    ("England/Wales: Bristol to Chepstow", (51.454, -2.588), (51.641, -2.675)),
    ("England/Scotland: Carlisle to Dumfries", (54.895, -2.938), (55.070, -3.604)),
    ("Scotland: Edinburgh to Livingston", (55.954, -3.189), (55.883, -3.522)),
    ("Northern Ireland: Belfast to Lisburn", (54.597, -5.930), (54.516, -6.058)),
)


class VerificationError(RuntimeError):
    pass


def sha_file(path):
    h=hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(8*1024*1024),b""):
            h.update(chunk)
    return h.hexdigest()


def check_manifest(data):
    if data.get("format")!=FORMAT or data.get("licence")!="ODbL-1.0":
        raise VerificationError("Wrong format/licence")
    if not data.get("source_tag","").startswith("uk-map-"):
        raise VerificationError("Unpinned UK source tag")
    for key in ("source_sha256","builder_sha256","database_sha256","gzip_sha256"):
        value=data.get(key,"")
        if not isinstance(value,str) or len(value)!=64 or any(c not in "0123456789abcdef" for c in value):
            raise VerificationError("Bad SHA-256 field: "+key)
    raw=data.get("database_bytes")
    gz=data.get("gzip_bytes")
    if not isinstance(raw,int) or raw<1024 or not isinstance(gz,int) or gz<100:
        raise VerificationError("Invalid UK graph sizes")
    parts=data.get("parts")
    if not isinstance(parts,list) or not 1<=len(parts)<=100:
        raise VerificationError("Wrong routing part list")
    total=0
    for index,part in enumerate(parts):
        if part.get("name")!=f"uk-routing.sqlite.gz.part-{index:03d}":
            raise VerificationError("Missing/reordered routing part")
        if not isinstance(part.get("bytes"),int) or not 0<part["bytes"]<=850_000_000:
            raise VerificationError("Invalid part size")
        sha=part.get("sha256","")
        if len(sha)!=64 or any(c not in "0123456789abcdef" for c in sha):
            raise VerificationError("Invalid part SHA-256")
        total+=part["bytes"]
    if total!=gz:
        raise VerificationError("Routing parts do not sum to compressed length")
    return parts


class PartStream:
    """Constant-memory concatenated gzip reader, checks every original part."""
    def __init__(self,folder,parts):
        self.folder=Path(folder)
        self.parts=parts
        self.next=0
        self.current=None
        self.used=0
        self.part_sha=hashlib.sha256()
        self.full_sha=hashlib.sha256()
        self.bytes_read=0

    def read(self,n=-1):
        if n<0: n=1024*1024
        if n==0: return b""
        chunks=[]
        remaining=n
        while remaining>0:
            if self.current is None:
                if self.next>=len(self.parts):
                    break
                info=self.parts[self.next]
                path=self.folder/info["name"]
                if not path.is_file() or path.stat().st_size!=info["bytes"]:
                    raise VerificationError("Missing/incorrect part: "+info["name"])
                self.current=path.open("rb")
                self.part_sha=hashlib.sha256()
                self.used=0
            piece=self.current.read(min(remaining,1024*1024))
            if not piece:
                info=self.parts[self.next]
                self.current.close()
                self.current=None
                if self.used!=info["bytes"] or self.part_sha.hexdigest()!=info["sha256"]:
                    raise VerificationError("Routing part digest mismatch: "+info["name"])
                self.next+=1
                continue
            chunks.append(piece)
            self.part_sha.update(piece)
            self.full_sha.update(piece)
            remaining-=len(piece)
            self.used+=len(piece)
            self.bytes_read+=len(piece)
        return b"".join(chunks)

    def complete(self):
        while self.read(1024*1024):
            pass
        return self.full_sha.hexdigest()


def restore(manifest, parts_dir, destination):
    parts=check_manifest(manifest)
    expected={p["name"] for p in parts}
    actual={p.name for p in Path(parts_dir).glob("uk-routing.sqlite.gz.part-*")}
    if expected!=actual:
        raise VerificationError("Unexpected/missing UK routing parts: "+repr(expected^actual))
    target=Path(destination)
    target.parent.mkdir(parents=True,exist_ok=True)
    if shutil.disk_usage(target.parent).free < manifest["database_bytes"]+200_000_000:
        raise VerificationError("Insufficient runner storage for full uncompressed UK graph")
    staged=target.with_suffix(".incomplete")
    staged.unlink(missing_ok=True)
    src=PartStream(parts_dir,parts)
    raw_digest=hashlib.sha256()
    total=0
    try:
        with gzip.GzipFile(fileobj=src,mode="rb") as gzip_input, staged.open("wb") as db:
            while True:
                chunk=gzip_input.read(1024*1024)
                if not chunk:
                    break
                db.write(chunk)
                raw_digest.update(chunk)
                total+=len(chunk)
                if total>manifest["database_bytes"]:
                    raise VerificationError("Decompressed database too large")
        gzip_sha=src.complete()
        if src.bytes_read!=manifest["gzip_bytes"] or gzip_sha!=manifest["gzip_sha256"]:
            raise VerificationError("Compressed routing graph hash mismatch")
        if total!=manifest["database_bytes"] or raw_digest.hexdigest()!=manifest["database_sha256"]:
            raise VerificationError("Raw UK routing SQLite SHA-256 mismatch")
        staged.replace(target)
    finally:
        staged.unlink(missing_ok=True)
    return total


def metres(a,b):
    la,lo=math.radians(a[0]),math.radians(a[1])
    lb,ln=math.radians(b[0]),math.radians(b[1])
    h=math.sin((lb-la)/2)**2+math.cos(la)*math.cos(lb)*math.sin((ln-lo)/2)**2
    return 12742017.6*math.asin(min(1,math.sqrt(h)))


class OfflineRoads:
    """Engineering incoming-edge A*, snap limit and turn policies; alternative anchors are diagnostic only."""
    def __init__(self,path):
        self.db=sqlite3.connect("file:"+str(Path(path).resolve())+"?mode=ro",uri=True)
        self.db.row_factory=None
        meta=dict(self.db.execute("SELECT key,value FROM meta"))
        if meta.get("format")!=FORMAT or meta.get("vehicle")!="motorcar":
            raise VerificationError("Incompatible UK car routing data")
        self.source=meta["source_tag"]

    def close(self):
        self.db.close()

    def nearest(self,point, require_departure=False):
        delta=SNAP_METRES/111000.0
        lon_delta=delta/max(0.1,math.cos(math.radians(point[0])))
        answer=None
        best=SNAP_METRES
        for nid,lat,lon in self.db.execute(
                "SELECT n.id,n.lat,n.lon FROM nodes n "
                "WHERE n.lat BETWEEN ? AND ? AND n.lon BETWEEN ? AND ? "
                "AND NOT EXISTS (SELECT 1 FROM blocked b WHERE b.id=n.id)",
                (point[0]-delta,point[0]+delta,point[1]-lon_delta,point[1]+lon_delta)):
            d=metres(point,(lat,lon))
            if d<best and (not require_departure or self.outgoing(nid)):
                answer=(nid,(lat,lon))
                best=d
        return answer

    @lru_cache(maxsize=20000)
    def outgoing(self,node):
        return tuple(self.db.execute(
            "SELECT e.id,e.dst,e.way,e.seconds,n.lat,n.lon,e.metres "
            "FROM edges e JOIN nodes n ON n.id=e.dst WHERE e.src=? "
            "AND NOT EXISTS(SELECT 1 FROM blocked b WHERE b.id=e.dst) "
            "AND NOT EXISTS(SELECT 1 FROM blocked_ways b WHERE b.id=e.way)",(node,)))

    @lru_cache(maxsize=20000)
    def rules(self,via,from_way):
        return tuple(self.db.execute("SELECT to_way,policy FROM restrictions "
                                     "WHERE (via=? OR via=0) AND from_way=?",
                                     (via,from_way)))

    @staticmethod
    def turn_allowed(prev_node,next_node,next_way,rules):
        only=False
        matched=False
        explicit_u=False
        for to_way,policy in rules:
            if policy==1 and to_way==next_way:
                return False
            if policy==3 and to_way==next_way and next_node==prev_node:
                return False
            if policy in (2,4):
                only=True
                if to_way==next_way and (policy==2 or next_node==prev_node):
                    matched=True
                    if policy==4:
                        explicit_u=True
        return (not only or matched) and (next_node!=prev_node or explicit_u)

    def route_exact(self,start,end,max_expansions=MAX_EXPANSIONS,max_seconds=160):
        origin=self.nearest(start, require_departure=True)
        target=self.nearest(end)
        if origin is None or target is None:
            return {"ok":False,"reason":"No road node near UK start/end", "expanded":0}
        if origin[0]==target[0]:
            return {"ok":False,"reason":"Same snapped junction","expanded":0}
        queue=[]
        dest_id,dest_point=target
        heapq.heappush(queue,(metres(origin[1],dest_point)*3.6/160,0.0,0,
                              origin[0],0,0,origin[1],0.0))
        best={0:0.0}
        parents={}
        expanded=0
        started=time.monotonic()
        while queue and expanded<max_expansions:
            if time.monotonic()-started>max_seconds:
                return {"ok":False,"reason":"Route computation time bound", "expanded":expanded}
            f,g,edge_id,node,prev_node,from_way,position,travelled_metres=heapq.heappop(queue)
            if g>best.get(edge_id,math.inf)+1e-7:
                continue
            if node==dest_id:
                path=[]
                current=edge_id
                while current!=0:
                    path.append(current)
                    current=parents[current]
                path.reverse()
                return {"ok":True,"edges":len(path),
                        "distance_km":round(travelled_metres/1000,2),
                        "minutes":round(g/60,1),"expanded":expanded,
                        "elapsed_seconds":round(time.monotonic()-started,2)}
            expanded+=1
            turn_rules=self.rules(node,from_way) if edge_id else ()
            for eid,to,way,seconds,lat,lon,length in self.outgoing(node):
                if edge_id and not self.turn_allowed(prev_node,to,way,turn_rules):
                    continue
                cost=g+seconds
                if cost+1e-7>=best.get(eid,math.inf):
                    continue
                best[eid]=cost
                parents[eid]=edge_id
                heuristic=SEARCH_WEIGHT*metres((lat,lon),dest_point)*3.6/160
                heapq.heappush(queue,(cost+heuristic,cost,eid,to,node,way,
                                      (lat,lon),travelled_metres+length))
        return {"ok":False,"reason":"Android A* work bound" if expanded>=max_expansions
                else "Disconnected/restricted road network","expanded":expanded}

    def anchor_candidates(self,point,departure=False):
        """Find distinct nearby real road nodes; never synthesize connecting edges."""
        delta=SNAP_METRES/111000.0
        lon_delta=delta/max(0.1,math.cos(math.radians(point[0])))
        rows=self.db.execute(
            "SELECT n.id,n.lat,n.lon FROM nodes n WHERE n.lat BETWEEN ? AND ? "
            "AND n.lon BETWEEN ? AND ? AND NOT EXISTS "
            "(SELECT 1 FROM blocked b WHERE b.id=n.id)",
            (point[0]-delta,point[0]+delta,point[1]-lon_delta,point[1]+lon_delta))
        nearby=[]
        for nid,lat,lon in rows:
            d=metres(point,(lat,lon))
            if d<=SNAP_METRES:nearby.append((d,nid,(lat,lon)))
        selected=[]
        for d,nid,pos in sorted(nearby):
            if departure and not self.outgoing(nid):continue
            if any(metres(pos,old[2])<20 for old in selected):continue
            selected.append((d,nid,pos))
            if len(selected)>=16:break
        return selected

    def route(self,start,end,max_expansions=MAX_EXPANSIONS,max_seconds=160):
        """Engineering-only anchor fallback; shared search budget, no access claims.
        Exact snap is preferred. Alternative snaps are recorded as access gaps.
        """
        began=time.monotonic()
        if max_expansions<20:return self.route_exact(start,end,max_expansions,max_seconds)
        first=self.route_exact(start,end,max_expansions=max_expansions//4,max_seconds=max_seconds/3)
        if first["ok"]:
            first["anchor_mode"]="nearest"
            return first
        used=first["expanded"]
        if first["reason"]=="Same snapped junction":return first
        origins=self.anchor_candidates(start,True)
        targets={nid:(d,pos) for d,nid,pos in self.anchor_candidates(end)}
        if not origins or not targets:return first
        # The route excludes unverified off-road access. Penalise larger snap
        # gaps in search ordering only, not in the reported road travel time.
        penalty=0.8
        q=[];best={}
        for d,nid,pos in origins:
            key=-nid
            cost=d*penalty
            best[key]=cost
            h=SEARCH_WEIGHT*max(0,metres(pos,end)-SNAP_METRES)*3.6/160
            heapq.heappush(q,(cost+h,cost,key,nid,0,0,pos,0.0,0.0,0,d,nid))
        expanded=used
        while q and expanded<max_expansions:
            if time.monotonic()-began>max_seconds:
                return {"ok":False,"reason":"Route computation time bound","expanded":expanded}
            _,cost,key,node,prev,way,pos,length,seconds,count,origin_gap,origin_id=heapq.heappop(q)
            if cost>best.get(key,math.inf)+1e-7:continue
            if count and node in targets:
                end_gap=targets[node][0]
                return {"ok":True,"edges":count,"distance_km":round(length/1000,2),
                        "minutes":round(seconds/60,1),"expanded":expanded,
                        "elapsed_seconds":round(time.monotonic()-began,2),
                        "anchor_mode":"alternative-road-nodes",
                        "origin_node":origin_id,"target_node":node,
                        "origin_access_gap_m":round(origin_gap,1),
                        "target_access_gap_m":round(end_gap,1),
                        "access_verified":False,"nearest_failure":first["reason"]}
            expanded+=1
            rules=self.rules(node,way) if count else ()
            for eid,to,newway,duration,lat,lon,segment in self.outgoing(node):
                if count and not self.turn_allowed(prev,to,newway,rules):continue
                if not math.isfinite(duration) or duration<=0 or not math.isfinite(segment) or segment<=0:continue
                newcost=cost+duration
                if newcost+1e-7>=best.get(eid,math.inf):continue
                best[eid]=newcost
                nxt=(lat,lon)
                h=SEARCH_WEIGHT*max(0,metres(nxt,end)-SNAP_METRES)*3.6/160
                if to in targets:h+=targets[to][0]*penalty
                heapq.heappush(q,(newcost+h,newcost,eid,to,node,newway,nxt,
                                  length+segment,seconds+duration,count+1,origin_gap,origin_id))
        return {"ok":False,"reason":"Engineering A* work bound" if expanded>=max_expansions
                else "Disconnected/restricted road network after anchor fallback",
                "expanded":expanded,"nearest_failure":first["reason"]}

    def named_places(self,names):
        out={}
        for name in names:
            row=self.db.execute("SELECT lat,lon FROM places WHERE name=? COLLATE NOCASE LIMIT 1",
                                (name,)).fetchone()
            out[name]=bool(row)
        return out


def verify(dbpath,manifest,samples=SAMPLES):
    data={"schema":FORMAT,"source_tag":manifest["source_tag"],
          "source_sha256":manifest["source_sha256"],
          "builder_sha256":manifest["builder_sha256"],
          "attribution":ATTRIBUTION,"road_validated":False,"search_weight":SEARCH_WEIGHT,"max_expansions":MAX_EXPANSIONS,
          "counts":{},"named_places":{},"samples":[]}
    roads=OfflineRoads(dbpath)
    failures=[]
    try:
        for table in ("nodes","edges","restrictions","places"):
            data["counts"][table]=roads.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        if data["counts"]["nodes"]<1_000_000 or data["counts"]["edges"]<2_000_000:
            failures.append("Full-UK routing graph unexpectedly small")
        data["named_places"]=roads.named_places(
            ["Birmingham","Cardiff","Edinburgh","Belfast"])
        for name,present in data["named_places"].items():
            if not present:
                failures.append("UK place missing: "+name)
        for name,start,end in samples:
            result=roads.route(start,end)
            result["name"]=name
            data["samples"].append(result)
            if not result["ok"]:
                failures.append(name+": "+result["reason"])
            elif result.get("anchor_mode")=="alternative-road-nodes":
                failures.append(name+": connected alternative road nodes; endpoint access and Android parity unverified")
    finally:
        roads.close()
    data["failures"]=failures
    data["passed"]=not failures
    return data


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--manifest",type=Path,required=True)
    p.add_argument("--parts",type=Path,required=True)
    p.add_argument("--db",type=Path,required=True)
    p.add_argument("--report",type=Path,required=True)
    a=p.parse_args(argv)
    doc=json.loads(a.manifest.read_text())
    check_manifest(doc)
    if doc.get("builder_sha256")!=sha_file(Path(__file__).with_name("build_uk_roads.py")):
        raise VerificationError("Routing release built with an old importer")
    restored=restore(doc,a.parts,a.db)
    print("Verified UK road graph database:",restored,"bytes",flush=True)
    result=verify(a.db,doc)
    a.report.write_text(json.dumps(result,indent=2,sort_keys=True)+"\n")
    for sample in result["samples"]:
        print(sample["name"],sample["ok"],sample.get("reason",""),
              sample["expanded"],sample.get("elapsed_seconds"),flush=True)
    if result["failures"]:
        print("FAIL UK coverage:",result["failures"],file=sys.stderr)
        return 2
    print("PASS UK-wide sample road routes. NOT FOR DRIVING.",flush=True)
    return 0


if __name__=="__main__":
    try:
        sys.exit(main())
    except (VerificationError,OSError,sqlite3.DatabaseError,KeyError,ValueError) as e:
        print("FAIL UK routing verification:",e,file=sys.stderr)
        sys.exit(2)
