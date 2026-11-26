#!/usr/bin/env python3
"""Package verified regional graph+display as immutable GitHub release asset candidates."""
import argparse, hashlib, json, re, zipfile
from pathlib import Path
from verify_unified_geometry import verify
def sha(b):return hashlib.sha256(b).hexdigest()
def pack(folder,out,tag):
    folder=Path(folder);out=Path(out);out.mkdir(parents=True,exist_ok=True)
    raw=(folder/"manifest.json").read_bytes()
    if len(raw)>2_000_000:raise ValueError("manifest too large")
    m=json.loads(raw);region=m.get("region_id","stockport")
    if not re.fullmatch(r"[a-z0-9-]{1,64}",region) or not re.fullmatch(r"dmregion-[A-Za-z0-9._-]+",tag):raise ValueError("invalid identity")
    report=verify(folder)
    if report["unmatched_edges"] or report["max_shared_coordinate_deviation_metres"]!=0:raise ValueError("Geometry proof failed")
    source=m["parent_source_sha256"]
    if source!="2c31f7d0c5c7280aee2130f38f7ebabb990626a8f5a208dba3c0279ada6c3164":raise ValueError("Unexpected source")
    w,s,e,n=map(float,m["bbox"].split(","))
    if not(-9<=w<e<=3 and 49<=s<n<=61 and e-w<=.15 and n-s<=.10):raise ValueError("Invalid region")
    asset=region+".zip";path=out/asset
    total=len(raw)+sum(t["bytes"] for t in m["tiles"].values())
    if total>150_000_000 or len(m["tiles"])>128:raise ValueError("Pack budget exceeded")
    with zipfile.ZipFile(path,"w",compression=zipfile.ZIP_STORED) as z:
        z.writestr("manifest.json",raw)
        for key,t in sorted(m["tiles"].items()):
            if not re.fullmatch(r"-?[0-9]+_-?[0-9]+",key) or t["name"]!=key+".dmt.gz":raise ValueError("Invalid tile name")
            b=(folder/t["name"]).read_bytes()
            if len(b)!=t["bytes"] or sha(b)!=t["sha256"]:raise ValueError("Tile mismatch")
            z.writestr(t["name"],b)
    entry={"id":region,"tag":tag,"asset":asset,"bytes":path.stat().st_size,"sha256":sha(path.read_bytes()),"manifestSha256":sha(raw),"parentSourceSha256":source,"bounds":[w+.002,s+.002,e-.002,n-.002],"roadValidated":False}
    (out/(region+"-catalog-entry.json")).write_text(json.dumps(entry,indent=2)+"\n")
    print(json.dumps(entry),flush=True)
    return entry
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("folder");p.add_argument("--out",required=True);p.add_argument("--tag",required=True);a=p.parse_args();pack(a.folder,a.out,a.tag)
