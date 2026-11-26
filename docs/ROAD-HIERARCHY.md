# DriveMate road hierarchy (cell overlay, levels 1 and 2)

DriveMate's own speed-up for long journeys, written for its tiled format.
It came out of the [Valhalla comparison](VALHALLA-COMPARISON.md): most
DriveMate failures were long trips that ran out of search budget because the
search examined almost every road in the region.

## Idea

The map is already split into 0.05° cells. For every cell,
`tools/dm_overlay.py` precomputes the fastest in-cell time from each road
that **enters** the cell to each road that **leaves** it. It uses exactly the
same edge-based turn rules (banned turns, only-turns, no U-turns, way-level
rules) and integer millisecond costs as the live search.

A journey is then searched road by road only in its **start and end cells**.
Every other cell is crossed in one step using the precomputed table. Paths
that leave a cell and come back are still built from these steps, so the
result is the **same route cost as a full road-by-road search**, not an
approximation. Afterwards each crossed cell is expanded back into its roads
(`unpack_cell`), so the route has full geometry, way IDs and edge IDs for
display and guidance.

## Level 2

Cells are grouped into blocks of 4 × 4 (about 22 × 13 km). For every block,
`build_level2` precomputes the fastest time from each road entering the block
to each road leaving it, by searching over that block's level-1 jumps. Level
1 is exact, so level 2 is too.

A journey uses road by road search in its start and end cells, level-1 jumps
in the rest of the start and end blocks, and one jump per block everywhere
else. Offline, a block is jumped only when all of its cells are downloaded;
otherwise its cells use level 1. Unpacking goes block jump → cell jumps
(`region_jumps`) → roads (`unpack_cell`).

## Data

`overlay.dmo` sits next to `routing.dma`. The manifest's `overlay` section
lists one checksummed gzip JSON piece per cell (`<cell>.dmo.gz`):

```
entries: [edge, src, dst, way, lat_e6, lon_e6]                 roads entering the cell
exits:   [edge, src, dst, dest_cell, way, lat_e6, lon_e6]      roads leaving the cell
cost:    [[ms or -1 per exit] per entry]
```

Coordinates are those of the edge's destination node, so the A* estimate
needs no full tile. North East England: 608 cells, 13,974 crossing roads,
327,429 precomputed jumps, 1.9 MB beside a 33 MB tile archive, about 2
minutes to build.

Level 2 is `overlay2.dmo` (manifest `overlay2`, one `<block>.dm2.gz` piece
per block). Entries add the cell the road arrives in:
`[edge, src, dst, way, lat_e6, lon_e6, cell]`. North East England: 50
blocks, 3,478 block-crossing roads, 242,012 jumps, 1.1 MB, 8 seconds.

Build: `python3 tools/compile_dmtiles_uk.py ... --overlay` (both levels), or
`python3 tools/dm_overlay.py --tiles <folder> --level2` on compiled tiles.
Catalogs without an overlay keep working with the full search; catalogs
with level 1 only keep working without level 2.

## Results (North East England, 66 journeys of 1–160 km)

| | Full search | Level 1 | Levels 1 + 2 |
|---|---|---|---|
| Journeys with identical time and distance to the full search | — | 66 / 66 | 66 / 66 |
| Total search steps (62 routable journeys) | 15,144,030 | 743,786 | 675,672 |
| Worst single journey | 1,050,895 | 33,470 | 32,650 |

Every journey is now inside the phone engine's 80,000-step limit. What is
left is mostly the road-by-road search of the start and end cells, which
in a city holds tens of thousands of roads. Level 2 matters more for trips
longer than this region allows.

## Engines

- Python mirror: `benchmark_dmtiles_uk.Archive.route_overlay`
  (`route_flat` is the full search).
- Android: `DmTileEngine.routeOverlay` (`routeFlat` is the full search).
  `DmTileDiskSource` caches, verifies and range-downloads overlay pieces of
  both levels exactly like tiles, and protects them with a journey.

## Tests

- `tools/test_dm_overlay.py`: every pair on a synthetic multi-cell grid with
  one-way streets and a banned turn; hierarchy and full search agree, for
  level 1 and for level 2 (small blocks so the grid spans several), plus the
  offline fallback.
- App `DmTileEngineOverlayTest`: the Java port matches the Java full search
  and this repository's Python results (fixture from
  `tools/make_app_overlay_fixture.py`, with level 2), falls back to level 1
  offline, rejects corrupt pieces, and does not count cached overlay pieces
  as map coverage.

## Next

- Faster start and end: smaller cells in dense cities, so less of the
  journey is searched road by road.
- Parallel build for the UK graph, then nationwide trips.
- Physical-device timing. This is not road-safety validation.
