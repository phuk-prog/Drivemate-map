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


def canon(node):
    """The node a record stands for: a copy made for a via-way restriction carries
    its original's id in field 6. The search remembers this as the previous node,
    so "no U-turn back to where you came from" also holds across copies."""
    return node[6] if len(node) > 6 else node[0]


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
                heapq.heappush(queue, (cost, edge, to, canon(node), new_way))
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


_W = {}


def _cell_worker_init(archive, rules):
    _W.update(stream=open(archive, "rb"), rules=rules)


def _cell_job(job):
    """One cell of the level-1 build: entry coordinates and cost matrix."""
    k, meta, entries, exit_ids = job
    nodes = read_tile(_W["stream"], meta)
    coords = [(nodes[dst][1], nodes[dst][2]) for _, _, dst, _ in entries]
    index = {edge: j for j, edge in enumerate(exit_ids)}
    cost = []
    for entry in entries:
        found, _ = cell_search(nodes, k, entry, _W["rules"])
        row = [-1] * len(exit_ids)
        for edge, ms in found.items():
            row[index[edge]] = ms
        cost.append(row)
    return coords, cost


def build_overlay(tiles_dir, workers=None):
    """Add the overlay archive to a compiled tiles folder (manifest.json +
    routing.dma) and record it, with checksums, in the manifest. Cells are
    computed in parallel on `workers` processes (default: all CPUs)."""
    import os
    workers = workers or os.cpu_count() or 1
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
                        rec = [edge, canon(n), to, dest, way, None, None]
                        exits[k].append(rec)
                        entries[dest].append(rec)
        # Pass 2, in parallel: per cell, coordinates of entering roads and the
        # cost matrix. Results are combined in catalog order, so the output is
        # identical whatever the number of workers.
        catalog = {}
        stats = {"cells": 0, "entries": 0, "exits": 0, "arcs": 0}
        jobs = [(k, meta, [(r[0], r[1], r[2], r[4]) for r in entries[k]], [r[0] for r in exits[k]])
                for k, meta in doc["tiles"].items()]
        init = (str(arc), rules)
        if workers > 1:
            from concurrent.futures import ProcessPoolExecutor
            with ProcessPoolExecutor(workers, initializer=_cell_worker_init, initargs=init) as pool:
                results = list(pool.map(_cell_job, jobs, chunksize=8))
        else:
            _cell_worker_init(*init)
            results = [_cell_job(j) for j in jobs]
        for (k, _, _, _), (coords, cost) in zip(jobs, results):
            for rec, (lat, lon) in zip(entries[k], coords):
                rec[5], rec[6] = lat, lon
            stats["arcs"] += sum(1 for row in cost for v in row if v >= 0)
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


# ------------------------------------------------------------------ level 2
# Blocks of BLOCK x BLOCK cells. For each block, the exact cost from every road
# entering the block to every road leaving it, found by searching over the
# block's level-1 jumps (each already an exact in-cell path). Same argument as
# level 1: paths inside a block are chains of in-cell paths; paths that leave
# and re-enter a block are chains of block jumps.
FORMAT2 = "drivemate-overlay2-v1"
BLOCK = 4


def block_key(cell, block):
    y, x = map(int, cell.split("_"))
    return f"{y // block}_{x // block}"


def region_search(load_level1, cells, entry_edge, entry_cell):
    """Dijkstra over level-1 jumps inside a block (set of cells), starting just
    after driving entry_edge into entry_cell. Returns (exit costs {edge: ms},
    parent {edge: (previous edge, cell jumped)})."""
    best = {entry_edge: 0}
    parent = {}
    exits = {}
    queue = [(0, entry_edge, entry_cell)]
    while queue:
        g, e, cell = heapq.heappop(queue)
        if g > best[e]:
            continue
        ov = load_level1(cell)
        for j, ms in enumerate(ov["cost"][ov["row"][e]]):
            if ms < 0:
                continue
            x = ov["exits"][j]
            edge, dest = x[0], x[3]
            cost = g + ms
            if cost >= best.get(edge, math.inf):
                continue
            best[edge] = cost
            parent[edge] = (e, cell)
            if dest in cells:
                heapq.heappush(queue, (cost, edge, dest))
            else:
                exits[edge] = cost
    return exits, parent


def region_jumps(load_level1, cells, entry_edge, entry_cell, exit_edge):
    """The level-1 jumps [(cell, entry edge, exit edge)] that make up one block
    jump, in driving order."""
    _, parent = region_search(load_level1, cells, entry_edge, entry_cell)
    out = []
    e = exit_edge
    while e != entry_edge:
        prev, cell = parent[e]
        out.append((cell, prev, e))
        e = prev
    out.reverse()
    return out


def level1_reader(tiles_dir, doc):
    ov = doc["overlay"]
    path = Path(tiles_dir) / ov["name"]
    if ov["bytes"] != path.stat().st_size or ov["sha256"] != sha_file(path):
        raise ValueError("Overlay digest mismatch")
    stream = path.open("rb")
    cache = {}

    def load(cell):
        if cell not in cache:
            meta = ov["cells"][cell]
            stream.seek(meta["offset"])
            raw = stream.read(meta["bytes"])
            if len(raw) != meta["bytes"] or digest(raw) != meta["sha256"]:
                raise ValueError("Overlay digest mismatch " + cell)
            d = json.loads(gzip.decompress(raw))
            d["row"] = {e[0]: i for i, e in enumerate(d["entries"])}
            cache[cell] = d
        return cache[cell]
    return load, stream


def build_level2(tiles_dir, block=BLOCK):
    """Add overlay2.dmo (one piece per block) to tiles that already have a
    level-1 overlay, and record it in the manifest."""
    tiles_dir = Path(tiles_dir)
    doc = json.loads((tiles_dir / "manifest.json").read_text())
    if "overlay" not in doc:
        raise ValueError("Level 1 overlay required")
    load, stream = level1_reader(tiles_dir, doc)
    blocks = {}
    for cell in doc["tiles"]:
        blocks.setdefault(block_key(cell, block), set()).add(cell)
    entries = {b: [] for b in blocks}
    exits = {b: [] for b in blocks}
    for cell in doc["tiles"]:
        ov = load(cell)
        here = block_key(cell, block)
        for x in ov["exits"]:
            edge, src, dst, dest, way, lat, lon = x
            there = block_key(dest, block)
            if there != here:
                exits[here].append(x)
                entries[there].append([edge, src, dst, way, lat, lon, dest])
    out = tiles_dir / "overlay2.dmo"
    written = {}
    offset = 0
    stats = {"blocks": 0, "entries": 0, "exits": 0, "arcs": 0}
    with out.open("wb") as output:
        for b in sorted(blocks):
            index = {x[0]: j for j, x in enumerate(exits[b])}
            cost = []
            for en in entries[b]:
                found, _ = region_search(load, blocks[b], en[0], en[6])
                row = [-1] * len(exits[b])
                for edge, ms in found.items():
                    row[index[edge]] = ms
                stats["arcs"] += sum(1 for v in row if v >= 0)
                cost.append(row)
            blob = gzip.compress(packed({"entries": entries[b], "exits": exits[b], "cost": cost}),
                                 compresslevel=6, mtime=0)
            output.write(blob)
            written[b] = {"name": b + ".dm2.gz", "offset": offset, "bytes": len(blob),
                          "sha256": digest(blob)}
            offset += len(blob)
            stats["blocks"] += 1
            stats["entries"] += len(entries[b])
            stats["exits"] += len(exits[b])
    stream.close()
    doc["overlay2"] = {"format": FORMAT2, "block_cells": block, "name": out.name, "bytes": offset,
                       "sha256": sha_file(out), "blocks": written, "stats": stats}
    (tiles_dir / "manifest.json").write_bytes(packed(doc))
    return doc


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tiles", required=True, help="folder with manifest.json and routing.dma")
    p.add_argument("--level2", action="store_true", help="also build level 2 (blocks of cells)")
    a = p.parse_args()
    print(json.dumps(build_overlay(a.tiles)["overlay"]["stats"]))
    if a.level2:
        print(json.dumps(build_level2(a.tiles)["overlay2"]["stats"]))
