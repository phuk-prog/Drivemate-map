#!/usr/bin/env python3
"""Original DriveMate tiled map format engineering pilot, ODbL source.
Not a production nationwide compiler: bounded XML extract only.
"""
import argparse, gzip, hashlib, json, math, sqlite3, tempfile, xml.etree.ElementTree as ET
from pathlib import Path
from build_uk_roads import Builder
FORMAT="drivemate-tiles-v1"
SCALE=1000000
CELL=50000
def key(lat,lon):
    return f"{math.floor(round(lat*SCALE)/CELL)}_{math.floor(round(lon*SCALE)/CELL)}"
def packed(obj):
    return json.dumps(obj,ensure_ascii=False,separators=(",",":"),sort_keys=True).encode()
def digest(data):return hashlib.sha256(data).hexdigest()
def compile_tiles(source,out,expected_sha):
    raw=Path(source).read_bytes()
    if len(raw)>30_000_000 or digest(raw)!=expected_sha:raise ValueError("Unverified or oversized pilot source")
    root=ET.fromstring(raw)
    tags=lambda e:{t.attrib["k"]:t.attrib["v"] for t in e.findall("tag")}
    nodes={int(n.attrib["id"]):(int(n.attrib["id"]),float(n.attrib["lat"]),float(n.attrib["lon"])) for n in root.findall("node")}
    ways={int(w.attrib["id"]):tags(w) for w in root.findall("way")}
    tiles={}
    # Identity and microdegree coordinates shared by routing and rendering.
    feature_segments={}
    def tile(k):return tiles.setdefault(k,{"nodes":[],"places":[],"features":[]})
    def address(tags,lat,lon):
        street=tags.get("addr:street") or tags.get("addr:place") or ""
        number=tags.get("addr:housenumber","")
        postcode=tags.get("addr:postcode","").strip()
        label=" ".join(x for x in (number,street) if x)
        if label and postcode:label+=", "+postcode
        elif not label:label=postcode
        if label:
            entry=[label,round(lat*SCALE),round(lon*SCALE),"address" if number and street else "postcode",postcode]
            tile(key(lat,lon))["places"].append(entry)
    with tempfile.TemporaryDirectory() as td:
        b=Builder(Path(td)/"roads.sqlite")
        for n in root.findall("node"):
            i=int(n.attrib["id"]);b.node(*nodes[i],tags(n));address(tags(n),nodes[i][1],nodes[i][2])
        for w in root.findall("way"):
            refs=[int(n.attrib["ref"]) for n in w.findall("nd")]
            if all(i in nodes for i in refs):
                i=int(w.attrib["id"]);b.way(i,ways[i],[nodes[r] for r in refs])
                # Geometry section: duplicate only into cells touched by vertices.
                coords=[[round(nodes[r][1]*SCALE),round(nodes[r][2]*SCALE)] for r in refs]
                if coords:
                    feature=[i,ways[i],coords,refs]
                    feature_segments[i]={ (a,b) for a,b in zip(refs,refs[1:]) }
                    feature_segments[i].update((b,a) for a,b in zip(refs,refs[1:]))
                    for k in {key(nodes[r][1],nodes[r][2]) for r in refs}:tile(k)["features"].append(feature)
                    if any(k.startswith("addr:") for k in ways[i]):
                        # Anchor on an actual mapped vertex rather than an invented entrance.
                        mid=refs[len(refs)//2];address(ways[i],nodes[mid][1],nodes[mid][2])
                    if ways[i].get("name") and ways[i].get("highway"):
                        mid=refs[len(refs)//2];lat,lon=nodes[mid][1:]
                        tile(key(lat,lon))["places"].append([ways[i]["name"],round(lat*SCALE),round(lon*SCALE),"street"])
        for r in root.findall("relation"):
            b.turn(tags(r),[(m.attrib["role"],m.attrib["type"][0],int(m.attrib["ref"])) for m in r.findall("member")])
        stats=b.finish("wells-dmtiles-pilot",expected_sha,min_edges=500)
        with sqlite3.connect(Path(td)/"roads.sqlite") as db:
            blocked={r[0] for r in db.execute("SELECT id FROM blocked")}
            badways={r[0] for r in db.execute("SELECT id FROM blocked_ways")}
            records={}
            for i,lat,lon in db.execute("SELECT id,lat,lon FROM nodes"):
                if i in blocked:continue
                record=[i,round(lat*SCALE),round(lon*SCALE),[],[]]
                records[i]=record;tile(key(lat,lon))["nodes"].append(record)
            for eid,src,dst,way,metres,seconds,name,flags in db.execute("SELECT id,src,dst,way,metres,seconds,name,flags FROM edges"):
                if src not in records or dst not in records or way in badways:continue
                if (src,dst) not in feature_segments.get(way,set()):raise ValueError('Graph edge absent from original render way')
                n=records[dst]
                if records[src][1:3]!=[round(nodes[src][1]*SCALE),round(nodes[src][2]*SCALE)] or n[1:3]!=[round(nodes[dst][1]*SCALE),round(nodes[dst][2]*SCALE)]:raise ValueError('Graph/render coordinate mismatch')
                records[src][3].append([eid,dst,key(n[1]/SCALE,n[2]/SCALE),way,round(metres*1000),round(seconds*1000)])
            global_rules={}
            for via,frm,to,policy in db.execute("SELECT via,from_way,to_way,policy FROM restrictions"):
                if via==0:global_rules.setdefault(str(frm),[]).append([to,policy])
                elif via in records:records[via][4].append([frm,to,policy])
            for name,lat,lon,kind in db.execute("SELECT name,lat,lon,kind FROM places"):
                tile(key(lat,lon))["places"].append([name,round(lat*SCALE),round(lon*SCALE),kind])
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    catalog={}
    for k,t in sorted(tiles.items()):
        blob=gzip.compress(packed(t),compresslevel=9,mtime=0)
        if len(blob)>8_000_000 or len(packed(t))>24_000_000:raise ValueError("Cell exceeds Android reader bounds "+k)
        name=k+".dmt.gz";(out/name).write_bytes(blob)
        crossing={}
        for n in t["nodes"]:
            for e in n[3]:
                if e[2]!=k:crossing[e[2]]=min(crossing.get(e[2],e[5]),e[5])
        catalog[k]={"name":name,"bytes":len(blob),"sha256":digest(blob),"nodes":len(t["nodes"]),"edges":sum(len(n[3]) for n in t["nodes"]),"crossing_ms":crossing}
    manifest={"format":FORMAT,"scope":"pilot","geometry_contract":"way-node-segments-v1","source_sha256":expected_sha,"license":"ODbL-1.0","attribution":"© OpenStreetMap contributors","cell_microdegrees":CELL,"global_rules":global_rules,"tiles":catalog,"road_validated":False,"stats":stats}
    data=packed(manifest);(out/"manifest.json").write_bytes(data)
    print(json.dumps({"manifest_sha256":digest(data),"tiles":len(catalog),"compressed_tile_bytes":sum(x["bytes"] for x in catalog.values()),"source_bytes":len(raw),"stats":stats}))
    return manifest
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--source",required=True);p.add_argument("--sha256",required=True);p.add_argument("--out",required=True);a=p.parse_args();compile_tiles(a.source,a.out,a.sha256)
