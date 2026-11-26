#!/usr/bin/env python3
"""DriveMate road hierarchy, level 1: a per-cell overlay of crossing roads.

DriveMate's own design for its tiled format. For every map cell we
precompute the fastest in-cell time from each road that ENTERS the cell to
each road that LEAVES it, using exactly the same edge-based turn rules as the
live search. A journey then searches road by road only in its start and end
cells and jumps across every other cell in one step. Because each jump is an
exact in-cell shortest path, and paths that leave and re-enter a cell are
still built from jumps, the route cost equals a full road-by-road search.
The roads inside each jumped cell are recovered afterwards (unpack_cell).

Overlay archive: one gzip JSON blob per cell,
  {"entries": [[edge, src, dst, way, lat_e6, lon_e6], ...],
   "exits":   [[edge, src, dst, dest_cell, way, lat_e6, lon_e6], ...],
   "cost":    [[ms or -1 per exit] per entry]}
lat/lon are of the edge's destination node, so a search can estimate
remaining time without loading the full tile.
"""
import argparse
import gzip
import heapq
import json
import math
from pathlib import Path

from compile_dmtiles import digest, packed
from verify_uk_graph import OfflineRoads, sha_file

FORMAT = "drivemate-overlay-v1"
turn_allowed = OfflineRoads.turn_allowed


def state_rules(global_rules, node, way):
    """Turn rules that apply when standing on `node` having arrived on `way`.
    Identical to the live search (benchmark_dmtiles_uk / DmTileEngine)."""
    return global_rules.get(str(way), []) + [[r[1], r[2]] for r in node[4] if r[0] == way]


def cell_search(nodes, cell, entry, global_rules):
    """Edge-based Dijkstra inside one cell, starting just after driving entry
    edge (edge, src, dst, way). Integer milliseconds, so results are exact.
    Returns (exit costs {edge: ms}, parent {edge: (prev_edge, record)})."""
    eid, src, dst, way = entry[:4]
    best = {eid: 0}
    parent = {}
    exits = {}
    queue = [(0, eid, dst, src, way)]
    while queue:
        g, e, nid, prev, cur_way = heapq.heappop(queue)
        if g > best[e]:
            continue
        node = nodes[nid]
        rules = state_rules(global_rules, node, cur_way)
        for edge, to, dest, new_way, mm, ms in node[3]:
            if not turn_allowed(prev, to, new_way, rules):
                continue
            cost = g + ms
            if cost >= best.get(edge, math.inf):
                continue
            best[edge] = cost
            parent[edge] = (e, (edge, to, dest, new_way, mm, ms, nid))
            if dest == cell:
                heapq.heappush(queue, (cost, edge, to, nid, new_way))
            else:
                exits[edge] = cost
    return exits, parent


def unpack_cell(nodes, cell, entry, exit_edge, global_rules):
    """Roads driven inside `cell` from entry edge to exit_edge (inclusive of
    the exit), as edge records (edge, to, dest, way, mm, ms, from_node)."""
    _, parent = cell_search(nodes, cell, entry, global_rules)
    out = []
    e = exit_edge
    while e != entry[0]:
        prev, record = parent[e]
        out.append(record)
        e = prev
    out.reverse()
    return out


def read_tile(stream, entry):
    stream.seek(entry["offset"])
    raw = stream.read(entry["bytes"])
    if len(raw) != entry["bytes"] or digest(raw) != entry["sha256"]:
        raise ValueError("Tile digest mismatch")
    return {n[0]: n for n in json.loads(gzip.decompress(raw))["nodes"]}


def build_overlay(tiles_dir):
    """Add the overlay archive to a compiled tiles folder (manifest.json +
    routing.dma) and record it, with checksums, in the manifest."""
    tiles_dir = Path(tiles_dir)
    doc = json.loads((tiles_dir / "manifest.json").read_text())
    arc = tiles_dir / doc["archive"]["name"]
    if doc["archive"]["bytes"] != arc.stat().st_size or doc["archive"]["sha256"] != sha_file(arc):
        raise ValueError("Archive digest mismatch")
    rules = doc["global_rules"]
    entries = {k: [] for k in doc["tiles"]}
    exits = {k: [] for k in doc["tiles"]}
    with arc.open("rb") as stream:
        # Pass 1: every road crossing a cell border is an exit of one cell and
        # an entry of its neighbour (the same record object in both lists).
        for k, meta in doc["tiles"].items():
            for n in read_tile(stream, meta).values():
                for edge, to, dest, way, mm, ms in n[3]:
                    if dest != k:
                        if dest not in doc["tiles"]:
                            raise ValueError("Crossing into unknown cell " + dest)
                        rec = [edge, n[0], to, dest, way, None, None]
                        exits[k].append(rec)
                        entries[dest].append(rec)
        # Pass 2: coordinates for crossing destinations, then the cost matrix.
        catalog = {}
        stats = {"cells": 0, "entries": 0, "exits": 0, "arcs": 0}
        for k, meta in doc["tiles"].items():
            nodes = read_tile(stream, meta)
            for rec in entries[k]:
                node = nodes[rec[2]]
                rec[5], rec[6] = node[1], node[2]
            index = {rec[0]: j for j, rec in enumerate(exits[k])}
            cost = []
            for rec in entries[k]:
                found, _ = cell_search(nodes, k, (rec[0], rec[1], rec[2], rec[4]), rules)
                row = [-1] * len(exits[k])
                for edge, ms in found.items():
                    row[index[edge]] = ms
                stats["arcs"] += sum(1 for v in row if v >= 0)
                cost.append(row)
            catalog[k] = {"entries": entries[k], "exits": exits[k], "cost": cost}
            stats["cells"] += 1
            stats["entries"] += len(entries[k])
            stats["exits"] += len(exits[k])
        # Exit coordinates are filled when their destination cell is visited,
        # so blobs are written only after every cell has been processed.
        out = tiles_dir / "overlay.dmo"
        written = {}
        offset = 0
        with out.open("wb") as output:
            for k, c in catalog.items():
                blob_doc = {"entries": [[r[0], r[1], r[2], r[4], r[5], r[6]] for r in c["entries"]],
                            "exits": c["exits"], "cost": c["cost"]}
                blob = gzip.compress(packed(blob_doc), compresslevel=6, mtime=0)
                output.write(blob)
                # name: how a device cache fetches this piece (as <cell>.dmt.gz for tiles)
                written[k] = {"name": k + ".dmo.gz", "offset": offset, "bytes": len(blob),
                              "sha256": digest(blob)}
                offset += len(blob)
    doc["overlay"] = {"format": FORMAT, "name": out.name, "bytes": offset,
                      "sha256": sha_file(out), "cells": written, "stats": stats}
    (tiles_dir / "manifest.json").write_bytes(packed(doc))
    return doc


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tiles", required=True, help="folder with manifest.json and routing.dma")
    a = p.parse_args()
    print(json.dumps(build_overlay(a.tiles)["overlay"]["stats"]))
