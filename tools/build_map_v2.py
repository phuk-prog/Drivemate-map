#!/usr/bin/env python3
"""Build one verified road graph and exact road geometry store from one OSM snapshot.
Raw tags are observations, not verified legal limits. No external source merging.
"""
import argparse, json, math, sqlite3, hashlib
from pathlib import Path
from build_uk_roads import Builder, digest, DRIVABLE

FORMAT="drivemate-map-v2"
SCALE=10000000
def packed(x): return json.dumps(x,ensure_ascii=False,separators=(",",":"),sort_keys=True)
def coord(lat,lon):
    if not math.isfinite(lat) or not math.isfinite(lon) or not -90<=lat<=90 or not -180<=lon<=180:
        raise ValueError("Invalid source position")
    return round(lat*SCALE),round(lon*SCALE)
class Unified(Builder):
    def __init__(self,path):
        super().__init__(path)
        self.db.executescript("""
        CREATE TABLE render_way(id INTEGER PRIMARY KEY, tags TEXT NOT NULL, refs TEXT NOT NULL, coords TEXT NOT NULL);
        CREATE VIRTUAL TABLE render_bounds USING rtree(id,min_lon,max_lon,min_lat,max_lat);
        CREATE TABLE render_segment(way INTEGER NOT NULL, a INTEGER NOT NULL,b INTEGER NOT NULL,
          alat INTEGER NOT NULL,alon INTEGER NOT NULL,blat INTEGER NOT NULL,blon INTEGER NOT NULL,
          PRIMARY KEY(way,a,b)) WITHOUT ROWID;
        CREATE TABLE mapped_point(id INTEGER PRIMARY KEY,lat INTEGER NOT NULL,lon INTEGER NOT NULL,tags TEXT NOT NULL,name TEXT NOT NULL,postcode TEXT NOT NULL);
        CREATE INDEX mapped_point_name ON mapped_point(name COLLATE NOCASE);
        CREATE INDEX mapped_point_postcode ON mapped_point(postcode COLLATE NOCASE);
        CREATE INDEX mapped_point_position ON mapped_point(lat,lon);
        CREATE TABLE enforcement_relation(id INTEGER PRIMARY KEY,tags TEXT NOT NULL,members TEXT NOT NULL);
        CREATE TABLE enforcement_anchor(node INTEGER NOT NULL,relation INTEGER NOT NULL,PRIMARY KEY(node,relation)) WITHOUT ROWID;
        """)
        self.render_count=0
    def node(self,oid,lat,lon,tags):
        super().node(oid,lat,lon,tags)
        if any(k in tags for k in ("amenity","shop","tourism","entrance","place","addr:housenumber","addr:postcode","highway","emergency","healthcare","traffic_calming","aeroway","railway","barrier","man_made","public_transport")):
            y,x=coord(lat,lon)
            name=tags.get("name") or " ".join(filter(None,(tags.get("addr:housenumber"),tags.get("addr:street") or tags.get("addr:place"))))
            self.db.execute("INSERT INTO mapped_point VALUES (?,?,?,?,?,?)",(oid,y,x,packed(tags),name,tags.get("addr:postcode","")))
    def way(self,oid,tags,refs):
        # All road classes plus mapped natural/cartographic features; exact source vertices.
        road=bool(tags.get("highway")) or tags.get("route")=="ferry"
        display=road or any(k in tags for k in ("building","waterway","landuse","leisure","natural","railway","amenity","parking","aeroway","aerialway","man_made","boundary"))
        if not display or len(refs)<2:return
        cs=[coord(lat,lon) for _,lat,lon in refs];ids=[i for i,_,_ in refs]
        self.db.execute("INSERT INTO render_way VALUES (?,?,?,?)",(oid,packed(tags),packed(ids),packed(cs)))
        self.db.execute("INSERT INTO render_bounds VALUES (?,?,?,?,?)",(oid,min(x for y,x in cs)/SCALE,max(x for y,x in cs)/SCALE,min(y for y,x in cs)/SCALE,max(y for y,x in cs)/SCALE))
        if road and (tags.get("highway") in DRIVABLE or tags.get("route")=="ferry"):
            rows=[]
            for a,b,p,q in zip(ids,ids[1:],cs,cs[1:]):
                if a>b:a,b,p,q=b,a,q,p
                rows.append((oid,a,b,*p,*q))
            self.db.executemany("INSERT OR IGNORE INTO render_segment VALUES (?,?,?,?,?,?,?)",rows)
            super().way(oid,tags,refs)
        self.render_count+=1
        if self.render_count%10000==0:self.flush();self.db.commit()
    def enforcement(self,oid,tags,members):
        # Keep source identity and member ordering. No geometric or directional inference.
        if tags.get("type")!="enforcement" or tags.get("enforcement") not in ("maxspeed","average_speed","traffic_signals"):return
        if not 2<=len(members)<=1000:return
        self.db.execute("INSERT INTO enforcement_relation VALUES (?,?,?)",(oid,packed(tags),packed(members)))
        self.db.executemany("INSERT OR IGNORE INTO enforcement_anchor VALUES (?,?)",[(ref,oid) for role,kind,ref in members if role=="from" and kind=="n"])
    def finish_v2(self,tag,source_sha,min_edges):
        stats=super().finish(tag,source_sha,min_edges)
        db=sqlite3.connect(str(self.path))
        try:
            # Verify every stored directed edge, including those across cells, against
            # the original OSM way/node pair and original E7 positions.
            bad=db.execute("""SELECT e.id FROM edges e JOIN nodes n ON n.id=e.src JOIN nodes m ON m.id=e.dst
              LEFT JOIN render_segment s ON s.way=e.way AND s.a=min(e.src,e.dst) AND s.b=max(e.src,e.dst)
              WHERE s.way IS NULL OR
              (CASE WHEN e.src<e.dst THEN s.alat ELSE s.blat END)!=round(n.lat*10000000) OR
              (CASE WHEN e.src<e.dst THEN s.alon ELSE s.blon END)!=round(n.lon*10000000) OR
              (CASE WHEN e.src<e.dst THEN s.blat ELSE s.alat END)!=round(m.lat*10000000) OR
              (CASE WHEN e.src<e.dst THEN s.blon ELSE s.alon END)!=round(m.lon*10000000) LIMIT 1""").fetchone()
            if bad:raise ValueError("Graph/render identity mismatch: "+str(bad[0]))
            actual=db.execute("SELECT count(*) FROM edges").fetchone()[0]
            joined=db.execute("SELECT count(*) FROM edges e JOIN nodes n ON n.id=e.src JOIN nodes m ON m.id=e.dst").fetchone()[0]
            if actual!=joined or actual!=stats["edges"]:raise ValueError("Missing graph vertices")
            db.executemany("INSERT INTO meta VALUES (?,?)",{"map_v2_format":FORMAT,"geometry_contract":"osm-way-node-e7-v1","coordinate_scale":str(SCALE),"road_validated":"false"}.items())
            stats.update({"render_ways":db.execute("SELECT count(*) FROM render_way").fetchone()[0],"mapped_points":db.execute("SELECT count(*) FROM mapped_point").fetchone()[0],"verified_directed_edges":actual})
            db.commit()
            if db.execute("PRAGMA quick_check").fetchone()[0]!="ok":raise ValueError("Unified DB corrupt")
        finally:db.close()
        return stats
def build(source,sha,tag,out,min_edges):
    if digest(source)!=sha:raise ValueError("Source digest mismatch")
    import osmium
    out.mkdir(parents=True,exist_ok=True)
    stage=out/"map-v2.staged.sqlite";final=out/"map-v2.sqlite"
    if stage.exists() or final.exists():raise ValueError("Use fresh output")
    b=Unified(stage)
    class Handler(osmium.SimpleHandler):
        def node(self,n):
            tags=dict(n.tags)
            if tags and n.location.valid():b.node(n.id,n.location.lat,n.location.lon,tags)
        def way(self,w):
            tags=dict(w.tags)
            if not (tags.get("highway") or tags.get("route")=="ferry" or any(k in tags for k in ("building","waterway","landuse","leisure","natural","railway","amenity","parking","aeroway","aerialway","man_made","boundary"))):return
            if any(not n.location.valid() for n in w.nodes):
                b.stats["excluded_missing_render_locations"]+=1;return
            b.way(w.id,tags,[(n.ref,n.location.lat,n.location.lon) for n in w.nodes])
        def relation(self,r):
            if r.tags.get("type")=="restriction":b.turn(dict(r.tags),[(m.role,m.type,m.ref) for m in r.members])
            elif r.tags.get("type")=="enforcement":b.enforcement(r.id,dict(r.tags),[(m.role,m.type,m.ref) for m in r.members])
    try:
        Handler().apply_file(str(source),locations=True,idx="flex_mem")
        stats=b.finish_v2(tag,sha,min_edges)
        stage.rename(final)
        report={"format":FORMAT,"source_tag":tag,"source_sha256":sha,"geometry_contract":"osm-way-node-e7-v1","coordinate_scale":SCALE,"database_bytes":final.stat().st_size,"database_sha256":digest(final),"stats":stats,"licence":"ODbL-1.0","road_validated":False}
        (out/"manifest.json").write_text(json.dumps(report,indent=2)+"\n");print(packed(report),flush=True)
    except Exception:
        try:b.db.close()
        except Exception:pass
        stage.unlink(missing_ok=True);raise
def main():
    p=argparse.ArgumentParser();p.add_argument("--source",type=Path,required=True);p.add_argument("--sha",required=True);p.add_argument("--tag",required=True);p.add_argument("--out",type=Path,required=True);p.add_argument("--min-edges",type=int,default=1000000);a=p.parse_args();build(a.source,a.sha,a.tag,a.out,a.min_edges)
if __name__=="__main__":main()
