#!/usr/bin/env python3
"""Lossless navigation-tag index of a checksum-verified OSM snapshot.

Separate from production routing and display: raw tags are evidence, not validated
legal restrictions, route recommendations, real-time data or physical lane geometry.
The full original PBF remains the authoritative complete source.
"""
import argparse
from collections import defaultdict, Counter
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3

FORMAT = "drivemate-map-intelligence-v1"
LICENCE = "ODbL-1.0"
ATTRIBUTION = "© OpenStreetMap contributors, https://www.openstreetmap.org/copyright"
GROUPS = {
    "lane_count": ("lanes",), "turn_lanes": ("turn:lanes",),
    "lane_destinations": ("destination:lanes", "destination:ref:lanes"),
    "lane_change": ("change:lanes",), "lane_access": ("access:lanes", "vehicle:lanes", "motor_vehicle:lanes", "motorcar:lanes", "bus:lanes", "psv:lanes"),
    "speed_limit": ("maxspeed",), "speed_source": ("source:maxspeed", "maxspeed:type"),
    "signs_destinations": ("destination", "destination:ref", "destination:street", "destination:symbol", "junction:ref", "exit_to"),
    "oneway": ("oneway",), "access": ("access", "vehicle", "motor_vehicle", "motorcar"),
    "vehicle_dimensions": ("maxheight", "maxwidth", "maxlength", "maxweight", "maxaxleload"),
    "road_name_ref": ("name", "ref"), "surface": ("surface", "smoothness", "tracktype"),
    "junction": ("junction",), "structure": ("bridge", "tunnel", "layer"),
    "toll": ("toll",), "traffic_calming": ("traffic_calming",),
    "cycle_bus": ("cycleway", "busway", "bus", "psv"), "parking": ("parking", "parking:lane"),
    "hazard": ("hazard",), "lit": ("lit",), "construction": ("construction", "proposed"),
}
def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
def sha(path):
    h=hashlib.sha256()
    with Path(path).open("rb") as stream:
        for b in iter(lambda:stream.read(8*1024*1024),b""): h.update(b)
    return h.hexdigest()
def has(tags,prefixes):
    return any(k==p or k.startswith(p+":") for k in tags for p in prefixes)
def explicit_speed(tags):
    # Presence of a numeric value only; conditional/directional applicability not inferred.
    return any(re.fullmatch(r"[0-9]+(?:\.[0-9]+)?(?:\s*(?:mph|km/h|kmh))?",v.strip(),re.I)
               for k,v in tags.items() if k in ("maxspeed","maxspeed:forward","maxspeed:backward"))
def category(tags):
    # Preserve all tags on every selected entity, not just this selection list.
    keys=("highway","railway","aeroway","waterway","route","public_transport","barrier",
          "traffic_sign","traffic_signals","traffic_calming","amenity","shop","tourism",
          "leisure","healthcare","emergency","office","craft","historic","place",
          "building","entrance","addr","destination","junction","parking","man_made",
          "charging_station","access","maxspeed","restriction","connectivity","boundary")
    return next((k for k in keys if k in tags or any(t.startswith(k+":") for t in tags)),None)
def length(coords):
    result=0.0
    for a,b in zip(coords,coords[1:]):
        if a is None or b is None: continue
        lat1,lon1=map(math.radians,a);lat2,lon2=map(math.radians,b)
        h=math.sin((lat2-lat1)/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
        result+=12742017.6*math.asin(min(1,math.sqrt(h)))
    return result
class Builder:
    def __init__(self,path):
        self.db=sqlite3.connect(str(path))
        self.db.executescript("""
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=OFF;
        CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE feature(fid INTEGER PRIMARY KEY,osm_type TEXT NOT NULL,osm_id INTEGER NOT NULL,
            osm_version INTEGER,category TEXT NOT NULL,tags_json TEXT NOT NULL,
            name TEXT,ref TEXT,lat REAL,lon REAL,geometry_json TEXT,members_json TEXT,
            geometry_complete INTEGER NOT NULL);
        CREATE VIRTUAL TABLE bounds USING rtree(fid,min_lon,max_lon,min_lat,max_lat);
        """)
        self.counts=Counter();self.keys=Counter();self.classes=defaultdict(Counter);self.metres=defaultdict(Counter)
        self.features=[];self.bounds=[];self.next_id=0
    def add(self,kind,oid,version,tags,coords=None,members=None):
        cat=category(tags)
        if kind=="r" and tags.get("type") in ("restriction","connectivity","destination_sign","route","route_master","associatedStreet","street","multipolygon","boundary"):
            cat=tags["type"]
        if not cat:return
        # Store complete source tag dictionaries, ordered OSM refs/coordinates and relation member roles.
        # OSM account names, user IDs and changeset IDs are not copied.
        coords=coords or []; locations=[(c[1],c[2]) for c in coords if c[1] is not None and c[2] is not None]
        complete=bool(coords) and len(locations)==len(coords)
        self.next_id+=1;fid=self.next_id
        lat,lon=locations[0] if kind=="n" and locations else (None,None)
        self.features.append((fid,kind,oid,version,cat,canonical(tags),tags.get("name"),tags.get("ref"),lat,lon,
                              canonical(coords) if coords else None,canonical(members) if members is not None else None,int(complete)))
        if locations:
            self.bounds.append((fid,min(c[1] for c in locations),max(c[1] for c in locations),min(c[0] for c in locations),max(c[0] for c in locations)))
        self.counts[kind]+=1;self.counts["category:"+cat]+=1
        if coords and not complete:self.counts["incomplete_geometry"]+=1
        self.keys.update(tags.keys())
        if kind=="w" and "highway" in tags:
            road=tags["highway"];counts=self.classes[road];meters=self.metres[road]
            distance=length([(c[1],c[2]) if c[1] is not None and c[2] is not None else None for c in coords]) if complete else 0
            counts["ways"]+=1;counts["complete_geometry"]+=int(complete);meters["ways"]+=distance
            for key,prefixes in GROUPS.items():
                if has(tags,prefixes):counts[key]+=1;meters[key]+=distance
            if explicit_speed(tags):counts["numeric_speed_tag"]+=1;meters["numeric_speed_tag"]+=distance
            if any(k.endswith(":conditional") or ":conditional:" in k for k in tags):counts["conditional_tags"]+=1
        if len(self.features)>=10000:self.flush()
    def flush(self):
        self.db.executemany("INSERT INTO feature VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",self.features)
        self.db.executemany("INSERT INTO bounds VALUES (?,?,?,?,?)",self.bounds)
        self.db.commit();self.features.clear();self.bounds.clear()
    def finish(self,source_tag,source_sha,scope):
        self.flush()
        if not self.counts["w"]:raise ValueError("No indexed road/area ways")
        self.db.executescript("""
        CREATE UNIQUE INDEX osm_identity ON feature(osm_type,osm_id);
        CREATE INDEX feature_category ON feature(category);
        CREATE INDEX feature_name ON feature(name COLLATE NOCASE) WHERE name IS NOT NULL;
        CREATE INDEX feature_ref ON feature(ref) WHERE ref IS NOT NULL;
        PRAGMA user_version=1;
        """)
        self.db.executemany("INSERT INTO meta VALUES (?,?)",{
            "format":FORMAT,"source_tag":source_tag,"source_sha256":source_sha,"scope":scope,
            "licence":LICENCE,"attribution":ATTRIBUTION,"status":"EXPERIMENTAL_NOT_ROAD_VALIDATED",
            "tag_semantics":"raw OSM observations; not verified restrictions or guidance"}.items())
        self.db.commit()
        if self.db.execute("PRAGMA quick_check").fetchone()[0]!="ok":raise ValueError("SQLite integrity failed")
        if self.db.execute("SELECT count(*) FROM feature").fetchone()[0]!=self.next_id:raise ValueError("Feature count mismatch")
        self.db.close()
        classes={}
        for road,counts in sorted(self.classes.items()):
            n=counts["ways"];m=self.metres[road]["ways"]
            classes[road]={"counts":dict(counts),"complete_geometry_metres":round(m),
                "tag_presence_by_way_pct":{k:round(100*counts[k]/n,2) for k in GROUPS},
                "tag_presence_by_length_pct":{k:round(100*self.metres[road][k]/m,2) if m else None for k in GROUPS}}
        return {"format":FORMAT,"source_tag":source_tag,"source_sha256":source_sha,"scope":scope,
                "licence":LICENCE,"attribution":ATTRIBUTION,"road_validated":False,
                "features":dict(self.counts),"tag_keys":dict(self.keys),"road_classes":classes,
                "note":"Tag presence is not accuracy, lane usability or legal applicability. Missing tags remain unknown."}
def build(source,source_sha,source_tag,out,scope):
    if not re.fullmatch("[a-f0-9]{64}",source_sha) or sha(source)!=source_sha:raise ValueError("Source SHA256 mismatch")
    import osmium
    out.mkdir(parents=True,exist_ok=True);db=out/"map-intelligence.sqlite";stage=out/"map-intelligence.staged.sqlite"
    if db.exists() or stage.exists():raise ValueError("Use a fresh output directory")
    b=Builder(stage)
    class Handler(osmium.SimpleHandler):
        def node(self,n):
            tags=dict(n.tags)
            if not category(tags):return
            p=(n.id,n.location.lat,n.location.lon) if n.location.valid() else (n.id,None,None)
            b.add("n",n.id,n.version,tags,[p])
        def way(self,w):
            tags=dict(w.tags)
            if not category(tags):return
            coords=[(n.ref,n.location.lat,n.location.lon) if n.location.valid() else (n.ref,None,None) for n in w.nodes]
            b.add("w",w.id,w.version,tags,coords)
        def relation(self,r):
            tags=dict(r.tags)
            b.add("r",r.id,r.version,tags,members=[(m.type,m.ref,m.role) for m in r.members])
    try:
        Handler().apply_file(str(source),locations=True,idx="flex_mem")
        report=b.finish(source_tag,source_sha,scope)
        if scope=="uk" and sum(x["counts"]["ways"] for x in report["road_classes"].values())<1000000:
            raise ValueError("UK road coverage below minimum completeness gate")
        stage.rename(db)
        report["database_bytes"]=db.stat().st_size;report["database_sha256"]=sha(db)
        report["builder_sha256"]=sha(__file__)
        (out/"coverage.json").write_text(json.dumps(report,indent=2,sort_keys=True)+"\n")
    except Exception:
        try:b.db.close()
        except Exception:pass
        stage.unlink(missing_ok=True);raise
    return report
def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source",type=Path,required=True);p.add_argument("--source-sha256",required=True)
    p.add_argument("--source-tag",required=True);p.add_argument("--out",type=Path,required=True)
    p.add_argument("--scope",choices=["uk","pilot"],required=True)
    a=p.parse_args()
    if a.scope=="uk" and not re.fullmatch(r"uk-map-\d{8}T\d{6}Z-[a-f0-9]{12}",a.source_tag):p.error("Immutable UK source release required")
    report=build(a.source,a.source_sha256,a.source_tag,a.out,a.scope)
    print("Indexed:",report["features"],"bytes:",report["database_bytes"])
if __name__=="__main__":main()
