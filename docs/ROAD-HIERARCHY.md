# DriveMate road hierarchy (level 1 cell overlay)

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

Build: `python3 tools/compile_dmtiles_uk.py ... --overlay`, or
`python3 tools/dm_overlay.py --tiles <folder>` on compiled tiles. Catalogs
without an overlay keep working with the full search.

## Engines

- Python mirror: `benchmark_dmtiles_uk.Archive.route_overlay`
  (`route_flat` is the full search).
- Android: `DmTileEngine.routeOverlay` (`routeFlat` is the full search).
  `DmTileDiskSource` caches, verifies and range-downloads overlay pieces
  exactly like tiles.

## Tests

- `tools/test_dm_overlay.py`: every pair on a synthetic multi-cell grid with
  one-way streets and a banned turn; hierarchy and full search agree.
- App `DmTileEngineOverlayTest`: the Java port matches the Java full search
  and this repository's Python results (fixture from
  `tools/make_app_overlay_fixture.py`), rejects corrupt pieces, and does not
  count cached overlay pieces as map coverage.

## Next

- Level 2 (groups of cells) for nationwide trips.
- Parallel build for the UK graph.
- Physical-device timing. This is not road-safety validation.
