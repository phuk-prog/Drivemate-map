# Drivemate-map

Builds Drivemate's downloadable map areas. Everything here is our own code, with no third-party packages.

## Pipeline

1. `tools/fetch-tiles.mjs` downloads OpenStreetMap-derived vector tiles for a bounding box into `data/cache/` (not committed).
2. `tools/mvt.mjs` is our own Mapbox Vector Tile reader.
3. `tools/build-area.mjs` turns the tiles into one DMAP file in `data/out/` (not committed).
4. `tools/dmap.mjs` reads and writes the DMAP format, defined in `format/FORMAT.md`.
5. `tools/preview.mjs` renders a DMAP file to PNG with our own rasteriser, as a check.
6. `tools/osm-extract.mjs` reads an OpenStreetMap `.osm.pbf` extract (for example from Geofabrik) with our own reader (`tools/osm-pbf.mjs`) and caches turn restrictions and lane tags in `data/osm-cache/restrictions/`, `data/osm-cache/lanes/` and `data/osm-cache/warnings/` (kept apart from the map tiles in `data/cache/`). `tools/build-area.mjs` picks them up by area name and matches them to roads by location (`tools/restrictions.mjs`, `tools/lanes.mjs`). The map tiles do not carry these. `tools/fetch-restrictions.mjs` and `tools/fetch-lanes.mjs` do the same job through the Overpass API, but the public servers refuse GitHub's runners, so use the extract. The tests are listed in `Drivemate/PROGRESS.md`.

## Build Greater London

    node tools/fetch-tiles.mjs --bbox=-0.55,51.28,0.30,51.70 --zoom=14
    node tools/build-area.mjs --name=london --bbox=-0.55,51.28,0.30,51.70 --zoom=14
    node tools/preview.mjs data/out/london.dmap preview.png 1600 1200

## Data source and licence

Source: OpenStreetMap, read as OpenFreeMap's vector tiles (OpenMapTiles schema). Map data © OpenStreetMap contributors, licensed under ODbL. Any app that uses this data must show that attribution.

Known limits and the work to fix them are in `Drivemate/PROGRESS.md` (category 0, data quality).
