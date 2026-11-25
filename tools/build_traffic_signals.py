#!/usr/bin/env python3
"""Extract static OSM traffic-signal nodes, not actual phase or operational status."""
import hashlib,struct,subprocess,tempfile,xml.etree.ElementTree as ET
from pathlib import Path
def encode(xml,sha,out):
    points=set()
    for _,node in ET.iterparse(xml,events=("end",)):
        if node.tag=="node":
            if any(t.get("k")=="highway" and t.get("v")=="traffic_signals" for t in node.findall("tag")):
                lat=float(node.get("lat"));lon=float(node.get("lon"))
                if 49<=lat<=61 and -9<=lon<=3:points.add((round(lat*1e7),round(lon*1e7)))
            node.clear()
    data=struct.pack(">4s32sI",b"DMS1",bytes.fromhex(sha),len(points))+b"".join(struct.pack(">ii",*p) for p in sorted(points))
    out=Path(out);out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
    print("UK mapped traffic-signal locations",len(points),"bytes",len(data),flush=True)
    return len(points)
def extract(pbf,sha,out):
    # Called only after the complete PBF has been restored and SHA-verified.
    with tempfile.TemporaryDirectory(prefix="dm-signals-") as folder:
        f=Path(folder);subset=f/"signals.osm.pbf";xml=f/"signals.osm"
        subprocess.run(["osmium","tags-filter","-R",str(pbf),"n/highway=traffic_signals","-o",str(subset)],check=True)
        subprocess.run(["osmium","cat",str(subset),"-o",str(xml)],check=True)
        if not 1000<=encode(xml,sha,out)<=1000000:raise ValueError("Unexpected UK signal count")
