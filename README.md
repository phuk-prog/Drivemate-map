# Drivemate-map

Builds Drivemate's downloadable map areas. Everything here is our own code, with no third-party packages.

## Pipeline

1. `tools/fetch-tiles.mjs` downloads OpenStreetMap-derived vector tiles for a bounding box into `data/cache/` (not committed).
2. `tools/mvt.mjs` is our own Mapbox Vector Tile reader.
3. `tools/build-area.mjs` turns the tiles into one DMAP file in `data/out/` (not committed).
4. `tools/dmap.mjs` reads and writes the DMAP format, defined in `format/FORMAT.md`.
5. `tools/preview.mjs` renders a DMAP file to PNG with our own rasteriser, as a check.
6. `tools/osm-extract.mjs` reads an OpenStreetMap `.osm.pbf` extract (for example from Geofabrik) with our own reader (`tools/osm-pbf.mjs`) and caches turn restrictions and lane tags in `data/osm-cache/restrictions/`, `data/osm-cache/lanes/` and `data/osm-cache/warnings/` (kept apart from the map tiles in `data/cache/`). `tools/build-area.mjs` picks them up by area name and matches them to roads by location (`tools/restrictions.mjs`, `tools/lanes.mjs`). The map tiles do not carry these. `tools/fetch-restrictions.mjs` and `tools/fetch-lanes.mjs` do the same job through the Overpass API, but the public servers refuse GitHub's runners, so use the extract. Run `node tools/test-osm-extract.mjs` to check the reader.

## Build Greater London

    node tools/fetch-tiles.mjs --bbox=-0.55,51.28,0.30,51.70 --zoom=14
    node tools/build-area.mjs --name=london --bbox=-0.55,51.28,0.30,51.70 --zoom=14
    node tools/preview.mjs data/out/london.dmap preview.png 1600 1200

Tile download takes about 15 seconds for London (1,280 tiles). The build takes about 20 seconds. The DMAP version 2 file is about 163 MB.

Version 2 holds: 352k routable road edges; 271k non-routed lines (rail, Underground, rivers, footpaths, boundaries, piers, ferries); 204k areas (water, buildings, parks, woods, grass, farmland, land use); and 241k named labels (places, roads, water, parks, points of interest).

## Data source and licence

Source: OpenStreetMap, read as OpenFreeMap's vector tiles (OpenMapTiles schema). Map data © OpenStreetMap contributors, licensed under ODbL. Any app that uses this data must show that attribution.

Known limits of this first version:
- Road topology is built from tile line ends snapped within about 2 m. Roads that cross in the middle, with no shared point, are joined at the crossing (`tools/graph.mjs`, `joinCrossings`). Bridges and tunnels are skipped, using the OSM `brunnel` tag only. Roads that cross at a different height without that tag (for example, `layer` tags) are still joined, so this can create false junctions. Run `node tools/test-graph.mjs` to check the rules.
- Two-point loop roads (same start and end, two points) are dropped by the builder. Longer loops, such as roundabouts, are kept on purpose.
- Turn restrictions are not stored yet.
- Roads that cross a tile seam are kept once. Area features near a seam are kept once when their outer boundary matches. Areas that differ in shape at a seam are not checked, and can still appear twice.
- Labels are stored in the file. The preview tool does not draw text; the app will draw labels.
