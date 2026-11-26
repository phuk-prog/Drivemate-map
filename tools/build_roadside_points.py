#!/usr/bin/env python3
"""Static mapped roadside points; no real-time status, direction or warning guarantee."""
import math,struct,subprocess,tempfile,xml.etree.ElementTree as ET
from pathlib import Path

# Preserve the existing record size; DMH2 explicitly adds typed crossings.
KINDS={"camera":1,"crossing":2,"calming":3,"signal":4,"zebra":5,"pelican":6,"puffin":7,"toucan":8,"parallel":9,"pegasus":10,"signal_crossing":11}
def crossing_kind(tags):
    if tags.get("highway")!="crossing":return None
    ref=tags.get("crossing_ref","")
    legacy=tags.get("crossing","")
    named={"zebra","pelican","puffin","toucan","parallel","pegasus"}
    if ref in named and legacy in named and ref!=legacy:return KINDS["crossing"]
    name=ref if ref in named else legacy if legacy in named and not ref else ""
    signals=tags.get("crossing:signals","")
    if name in ("zebra","parallel") and (signals=="yes" or legacy=="traffic_signals"):return KINDS["crossing"]
    if name in ("pelican","puffin","toucan","pegasus") and (signals=="no" or legacy in ("unmarked","uncontrolled")):return KINDS["crossing"]
    if name:return KINDS[name]
    if signals=="yes" or legacy=="traffic_signals":return KINDS["signal_crossing"]
    # Markings alone are not proof of the legal crossing subtype.
    return KINDS["crossing"]
def kinds(tags):
    result=[]
    if tags.get("highway")=="speed_camera":result.append(KINDS["camera"])
    crossing=crossing_kind(tags)
    if crossing is not None:result.append(crossing)
    if tags.get("traffic_calming") in ("bump","hump","table","cushion","rumble_strip","chicane"):result.append(KINDS["calming"])
    if tags.get("highway")=="traffic_signals":result.append(KINDS["signal"])
    return result

def encode(xml,sha,out):
    points=set()
    # Bounded intermediate XML; clear elements and release processed top-level nodes.
    it=ET.iterparse(xml,events=("start","end"))
    _,root=next(it)
    for event,node in it:
        if event!="end" or node.tag!="node":continue
        tags={t.get("k"):t.get("v") for t in node.findall("tag")}
        lat=float(node.get("lat"));lon=float(node.get("lon"))
        if math.isfinite(lat) and math.isfinite(lon) and 49<=lat<=61 and -9<=lon<=3:
            for k in kinds(tags):points.add((round(lat*1e7),round(lon*1e7),k))
        node.clear();root.remove(node)
        if len(points)>2000000:raise ValueError("Roadside point count exceeds bound")
    target=Path(out);target.parent.mkdir(parents=True,exist_ok=True)
    data=struct.pack(">4s32sI",b"DMH2",bytes.fromhex(sha),len(points))
    with target.open("wb") as stream:
        stream.write(data)
        for p in sorted(points):stream.write(struct.pack(">iiB",*p))
    return len(points)

def extract(pbf,sha,out):
    with tempfile.TemporaryDirectory(prefix="dm-roadside-") as folder:
        f=Path(folder);subset=f/"points.osm.pbf";xml=f/"points.osm"
        subprocess.run(["osmium","tags-filter","-R",str(pbf),"n/highway=speed_camera,crossing,traffic_signals","n/traffic_calming","-o",str(subset)],check=True)
        subprocess.run(["osmium","cat",str(subset),"-o",str(xml)],check=True)
        n=encode(xml,sha,out)
        if not 1000<=n<=2000000:raise ValueError("Roadside point count outside UK bounds")
        print("UK static roadside points",n,flush=True)
