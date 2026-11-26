#!/usr/bin/env python3
"""Verify all candidate archive bytes and directed geometry before preview publication."""
import argparse,hashlib,json,re,tempfile,zipfile
from pathlib import Path
from verify_unified_geometry import verify
SOURCE="2c31f7d0c5c7280aee2130f38f7ebabb990626a8f5a208dba3c0279ada6c3164"
REGIONS=("stockport","south-manchester","south-manchester-stockport-corridor")
def sha(b):return hashlib.sha256(b).hexdigest()
def check(root,tag,out):
    entries=[];out.mkdir(parents=True,exist_ok=True)
    for region in REGIONS:
        files=list(root.rglob(region+"-catalog-entry.json"))
        if len(files)!=1:raise ValueError("Missing or duplicate "+region)
        e=json.loads(files[0].read_text())
        if e["id"]!=region or e["tag"]!=tag or e["asset"]!=region+".zip" or e["parentSourceSha256"]!=SOURCE or e["roadValidated"] is not False:raise ValueError("Candidate identity mismatch")
        asset=files[0].parent/e["asset"]
        if not 0<e["bytes"]<=160_000_000 or asset.stat().st_size!=e["bytes"]:raise ValueError("Archive size mismatch")
        blob=asset.read_bytes()
        if sha(blob)!=e["sha256"]:raise ValueError("Archive digest mismatch")
        with tempfile.TemporaryDirectory() as work,zipfile.ZipFile(asset) as z:
            folder=Path(work);infos=z.infolist();names=[i.filename for i in infos]
            if len(names)!=len(set(names)) or len(names)>129 or "manifest.json" not in names:raise ValueError("Invalid archive inventory")
            if any(i.is_dir() or not (i.filename=="manifest.json" or re.fullmatch(r"-?\d+_-?\d+\.dmt\.gz",i.filename)) or i.file_size>8_000_000 for i in infos):raise ValueError("Unsafe archive member")
            if sum(i.file_size for i in infos)>150_000_000 or z.getinfo("manifest.json").file_size>2_000_000:raise ValueError("Archive expansion limit")
            raw=z.read("manifest.json")
            if sha(raw)!=e["manifestSha256"]:raise ValueError("Manifest mismatch")
            m=json.loads(raw)
            if m["region_id"]!=region or m["parent_source_sha256"]!=SOURCE or m["road_validated"] is not False:raise ValueError("Manifest provenance mismatch")
            w,s,east,n=map(float,m["bbox"].split(","))
            bounds=[w+.002,s+.002,east-.002,n-.002]
            if bounds!=e["bounds"]:raise ValueError("Bounds mismatch")
            expected={"manifest.json"}|{t["name"] for t in m["tiles"].values()}
            if set(names)!=expected:raise ValueError("Unexpected member")
            (folder/"manifest.json").write_bytes(raw)
            for t in m["tiles"].values():
                b=z.read(t["name"])
                if len(b)!=t["bytes"] or sha(b)!=t["sha256"]:raise ValueError("Cell integrity mismatch")
                (folder/t["name"]).write_bytes(b)
            report=verify(folder)
            if report["unmatched_edges"] or report["max_shared_coordinate_deviation_metres"]!=0 or report["edges_checked"]<500:raise ValueError("Geometry verification failed")
            print(region,report["edges_checked"],"exact edges; preview only")
        (out/asset.name).write_bytes(blob);entries.append(e)
    (out/"native-region-catalog.json").write_text(json.dumps(entries,indent=2)+"\n")
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("root",type=Path);p.add_argument("--tag",required=True);p.add_argument("--out",type=Path,required=True);a=p.parse_args();check(a.root,a.tag,a.out)
