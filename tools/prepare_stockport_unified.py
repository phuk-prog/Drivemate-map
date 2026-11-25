#!/usr/bin/env python3
"""Build bounded Stockport data from an exact published UK OSM source, not live Overpass."""
import argparse,hashlib,json,os,re,subprocess,sys,tempfile,urllib.request
from pathlib import Path
from compile_dmtiles import compile_tiles
from verify_unified_geometry import verify
TAG="uk-map-20261125T034434Z-2c31f7d0c5c7"
MANIFEST_SHA="76e19fd9e582b1a0f1dd8231378d41754493f508211ca9953940dea2a1111be0"
URL="https://github.com/phuk-prog/Drivemate-map/releases/download/"+TAG+"/"
BBOX="-2.190,53.390,-2.135,53.425"
def open_asset(name):
    return urllib.request.urlopen(urllib.request.Request(URL+name,headers={"User-Agent":"DriveMate-unified-map-QA/1.0","Accept-Encoding":"identity"}),timeout=120)
def main():
    p=argparse.ArgumentParser();p.add_argument("--out",required=True);p.add_argument("--signals-out",type=Path);a=p.parse_args()
    out=Path(a.out).resolve();out.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="dm-stockport-") as work:
        w=Path(work);pbf=w/"uk.osm.pbf"
        with open_asset("manifest.json") as r:raw=r.read(100_001)
        if hashlib.sha256(raw).hexdigest()!=MANIFEST_SHA:raise ValueError("Pinned source manifest mismatch")
        m=json.loads(raw)
        if m["tag"]!=TAG or m["licence"]!="ODbL-1.0" or not 1<=len(m["parts"])<=8:raise ValueError("Source metadata mismatch")
        full=hashlib.sha256();total=0
        with pbf.open("wb") as stream:
            for i,part in enumerate(m["parts"]):
                name=part["name"];expected=part["bytes"]
                if name!=f"uk.osm.pbf.part-{i:03}" or not 0<expected<=850_000_000:raise ValueError("Invalid part")
                h=hashlib.sha256();size=0
                with open_asset(name) as r:
                    while True:
                        chunk=r.read(4*1024*1024)
                        if not chunk:break
                        size+=len(chunk)
                        if size>expected:raise ValueError("Part too long")
                        h.update(chunk);full.update(chunk);stream.write(chunk)
                if size!=expected or h.hexdigest()!=part["sha256"]:raise ValueError("Part integrity failure")
                total+=size;print("Verified",name,size,flush=True)
        if total!=m["bytes"] or full.hexdigest()!=m["sha256"]:raise ValueError("UK source integrity")
        clip=w/"stockport.osm.pbf";filtered=w/"stockport-filtered.osm.pbf";xml=w/"stockport.osm"
        subprocess.run(["osmium","extract","-b",BBOX,"-s","complete_ways","-o",str(clip),str(pbf)],check=True)
        if a.signals_out:
            from build_traffic_signals import extract
            extract(pbf,m["sha256"],a.signals_out)
        pbf.unlink()
        subprocess.run(["osmium","tags-filter",str(clip),"w/highway","w/building","w/waterway","w/natural=water","w/landuse","w/leisure","w/route=ferry","n/amenity","n/tourism","n/highway=motorway_junction","r/type=restriction","-o",str(filtered)],check=True)
        subprocess.run(["osmium","cat",str(filtered),"-o",str(xml)],check=True)
        print('Stockport XML bytes',xml.stat().st_size,flush=True)
        if xml.stat().st_size>160_000_000:raise ValueError("Stockport extract exceeds bounded XML pilot")
        digest=hashlib.sha256(xml.read_bytes()).hexdigest()
        compile_tiles(xml,out,digest,max_source_bytes=160_000_000)
        meta=json.loads((out/"manifest.json").read_text())
        meta.update({"scope":"stockport-unified-pilot","parent_source_tag":TAG,"parent_source_sha256":m["sha256"],"bbox":BBOX})
        (out/"manifest.json").write_text(json.dumps(meta,separators=(",",":"),sort_keys=True))
        report=verify(out);report["parent_source_tag"]=TAG;report["parent_source_sha256"]=m["sha256"];report["bbox"]=BBOX
        (out/"alignment-report.json").write_text(json.dumps(report,indent=2)+"\n")
        print("UNIFIED_STOCKPORT",json.dumps(report),flush=True)
if __name__=="__main__":main()
