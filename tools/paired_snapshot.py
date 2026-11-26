#!/usr/bin/env python3
"""Select/build immutable same-source UK navigation snapshot metadata.

No production publication, activation, TomTom content or user data.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
from restore_uk_valhalla import inspect_manifest
from map_intelligence_service import verify_pack

def digest(path):
    with Path(path).open("rb") as f:return hashlib.file_digest(f,"sha256").hexdigest()

def fingerprint(root):
    root=Path(root)
    h=hashlib.sha256()
    for name in ("build_map_intelligence.py","build_valhalla_graph.sh","package_valhalla_tiles.py","probe_valhalla_graph.py","paired_snapshot.py"):
        h.update(name.encode()+b"\0"+(root/name).read_bytes()+b"\0")
    return h.hexdigest()

def pair(graph,report,probes,builder):
    inspect_manifest(graph)
    if report.get("format")!="drivemate-map-intelligence-v1" or report.get("scope")!="uk" or report.get("licence")!="ODbL-1.0":
        raise ValueError("Expected full UK intelligence data")
    for key in ("source_tag","source_sha256"):
        if graph[key]!=report.get(key):raise ValueError("Source mismatch: "+key)
    for value in (builder,report.get("database_sha256")):
        if not isinstance(value,str) or not re.fullmatch("[a-f0-9]{64}",value):raise ValueError("Missing snapshot digest")
    if probes.get("passed") is not True or len(probes.get("samples",[]))<5 or not all(x.get("passed") is True for x in probes["samples"]):
        raise ValueError("UK native routing probes not all passed")
    if not isinstance(report.get("database_bytes"),int) or report["database_bytes"]<=0:raise ValueError("Missing database length")
    return {"format":"drivemate-paired-navigation-v1","source_tag":graph["source_tag"],
            "source_sha256":graph["source_sha256"],"builder_sha256":builder,
            "graph_sha256":graph["tile_extract_sha256"],"graph_bytes":graph["tile_extract_bytes"],
            "database_sha256":report["database_sha256"],"database_bytes":report["database_bytes"],
            "licence":"ODbL-1.0","status":"EXPERIMENTAL_NOT_ROAD_VALIDATED","road_validated":False}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--graph",type=Path,required=True);p.add_argument("--coverage",type=Path,required=True)
    p.add_argument("--probes",type=Path,required=True);p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    read=lambda path:json.loads(path.read_text())
    result=pair(read(a.graph),read(a.coverage),read(a.probes),fingerprint(Path(__file__).parent))
    a.out.write_text(json.dumps(result,indent=2,sort_keys=True)+"\n")
    print("Matched immutable snapshot:",result["source_tag"],result["source_sha256"])
if __name__=="__main__":main()
