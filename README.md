# Drivemate-map

Builds Drivemate's downloadable map areas. Everything here is our own code, with no third-party packages.

## Pipeline

1. `tools/fetch-tiles.mjs` downloads OpenStreetMap-derived vector tiles for a bounding box into `data/cache/` (not committed).
2. `tools/mvt.mjs` is our own Mapbox Vector Tile reader.
3. `tools/build-area.mjs` turns the tiles into one DMAP file in `data/out/` (not committed).
4. `tools/dmap.mjs` reads and writes the DMAP format, defined in `format/FORMAT.md`.
5. `tools/preview.mjs` renders a DMAP file to PNG with our own rasteriser, as a check.

## Build Greater London

    node tools/fetch-tiles.mjs --bbox=-0.55,51.28,0.30,51.70 --zoom=14
    node tools/build-area.mjs --name=london --bbox=-0.55,51.28,0.30,51.70 --zoom=14
    node tools/preview.mjs data/out/london.dmap preview.png 1600 1200

Tile download takes about 15 seconds for London (1,280 tiles). The build takes about 13 seconds. The DMAP file is about 120 MB.

## Data source and licence

Source: OpenStreetMap, read as OpenFreeMap's vector tiles (OpenMapTiles schema). Map data © OpenStreetMap contributors, licensed under ODbL. Any app that uses this data must show that attribution.

Known limits of this first version:
- Road topology is built from tile line ends snapped within about 2 m. Roads that cross without a shared end point are not joined. Turn restrictions are not stored yet.
- Area features near tile seams can appear twice. This is harmless for drawing and costs some size.
- Place-name labels are stored but not yet drawn.
