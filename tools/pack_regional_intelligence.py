#!/usr/bin/env python3
"""Bounded offline map-attribute pack, NOT an offline routing graph."""
import argparse, json, sqlite3
from pathlib import Path
from build_map_intelligence import Builder, sha
from map_intelligence_service import verify_pack

def pack(db,report,out,bbox):
    south,west,north,east=bbox
    if not 49<=south<north<=61 or not -9<=west<east<=3 or north-south>2 or east-west>3:
        raise ValueError("Invalid or oversized regional bounds")
    store=verify_pack(db,report);meta=store.metadata()
    out.mkdir(parents=True,exist_ok=True);target=out/"map-intelligence.sqlite"
    if target.exists():raise ValueError("Use a fresh output directory")
    builder=Builder(target)
    with store.connect() as c:
        for row in c.execute("""SELECT f.* FROM bounds b JOIN feature f ON b.fid=f.fid
            WHERE b.min_lat<=? AND b.max_lat>=? AND b.min_lon<=? AND b.max_lon>=?""",(north,south,east,west)):
            builder.add(row["osm_type"],row["osm_id"],row["osm_version"],json.loads(row["tags_json"]),
                json.loads(row["geometry_json"]) if row["geometry_json"] else None,
                json.loads(row["members_json"]) if row["members_json"] else None)
    # Unlocated relations intentionally excluded; cannot use this as routing or restriction authority.
    result=builder.finish(meta["source_tag"],meta["source_sha256"],"pilot")
    result.update(database_bytes=target.stat().st_size,database_sha256=sha(target),region_bbox=bbox,
        purpose="OFFLINE_ATTRIBUTES_ONLY",relations_complete=False)
    (out/"coverage.json").write_text(json.dumps(result,indent=2)+"\n")
    return result

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--db",type=Path,required=True);p.add_argument("--report",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True);p.add_argument("--bbox",nargs=4,type=float,required=True)
    a=p.parse_args();pack(a.db,a.report,a.out,a.bbox)
