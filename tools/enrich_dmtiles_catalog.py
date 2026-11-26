#!/usr/bin/env python3
"""Derive safe directed coarse-cell lower bounds from a verified national archive.
No shortcuts, no restrictions bypassed, no production publication."""
import argparse,gzip,json,hashlib
from pathlib import Path
from compile_dmtiles import packed,digest
from verify_uk_graph import sha_file
def enrich(manifest,archive,out):
    doc=json.loads(Path(manifest).read_text());arc=Path(archive)
    if doc["archive"]["bytes"]!=arc.stat().st_size or doc["archive"]["sha256"]!=sha_file(arc):raise ValueError("Archive digest mismatch")
    with arc.open("rb") as stream:
        for k,entry in doc["tiles"].items():
            stream.seek(entry["offset"]);raw=stream.read(entry["bytes"])
            if len(raw)!=entry["bytes"] or digest(raw)!=entry["sha256"]:raise ValueError("Tile digest mismatch "+k)
            crossing={}
            for n in json.loads(gzip.decompress(raw))["nodes"]:
                for e in n[3]:
                    if e[2]!=k:
                        if e[2] not in doc["tiles"] or e[5]<=0:raise ValueError("Invalid crossing")
                        crossing[e[2]]=min(crossing.get(e[2],e[5]),e[5])
            entry["crossing_ms"]=crossing
    Path(out).write_bytes(packed(doc))
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--manifest",required=True);p.add_argument("--archive",required=True);p.add_argument("--out",required=True);a=p.parse_args();enrich(a.manifest,a.archive,a.out)
