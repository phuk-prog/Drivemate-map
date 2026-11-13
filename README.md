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

Tile download takes about 15 seconds for London (1,280 tiles). The build takes about 20 seconds. The DMAP version 2 file is about 163 MB.

Version 2 holds: 352k routable road edges; 271k non-routed lines (rail, Underground, rivers, footpaths, boundaries, piers, ferries); 204k areas (water, buildings, parks, woods, grass, farmland, land use); and 241k named labels (places, roads, water, parks, points of interest).

## Map squares and how the map grows

Drawn-area downloads use fixed grid squares of 0.05 degrees (`tools/grid.mjs`). Each square is one gzip-compressed DMAP file, published as a GitHub release asset. A release holds at most 1000 files, so each latitude row has its own release:

    https://github.com/phuk-prog/Drivemate-map/releases/download/squares-lat<latIdx>/<squareId>.dmap.gz

`latIdx` is `floor(lat * 20)`, and a square id looks like `lat1068_lon-44`. Each entry in `data/published/squares/index.json` has the square's `url` and `release`. The Stockport and London squares are also uploaded to `maps-latest`, because older app builds read them there.

The scheduled workflow (`.github/workflows/update-maps.yml`) adds the next county on each run, with `tools/grow.mjs`. England goes first, then Wales, Scotland and Northern Ireland. The counties come from Geofabrik's index (`index-v1.json`). The next county is the one whose centre is nearest to something already built: Stockport, London, or a finished county. So the map grows outwards from them.

- **What one county builds:** every square its Geofabrik boundary touches. Each square gets roads from every extract whose boundary touches a square still to build, so border squares are complete. Squares that are already up to date are skipped.
- **Downloads:** an extract is downloaded only when a square that needs it must be built. It is downloaded again only when Geofabrik's Last-Modified date has changed. Extracts are kept between runs in the Actions cache.
- **Progress:** `data/published/growth.json` (committed) records each finished county with its start and end times, square count, bytes and extracts. It also records the county in progress, if any, and the extract downloads.
- **Check the plan:** `node tools/grow.mjs --dry-run` prints the next county, its squares and its extracts, and builds nothing. The OSM check workflow runs it on every push to a work branch.
- **Order:** edit `growth.json`. List ids in `"first"` to build them before anything else, list ids in `"skip"` to leave them out, and reorder `"phases"` to change the order of the countries. Geofabrik has no Northern Ireland extract, so that phase uses the part of `ireland-and-northern-ireland` inside Northern Ireland's bbox.
- **Speed:** set `GROW_PER_RUN` (counties per run, default 1) and `GROW_MINUTES` (time budget, default 240) in the workflow, or change its schedule (four runs a day). A county cut short by the time budget is finished on the next run.

Tests: `node tools/test-grow.mjs` uses a small sample of Geofabrik's index in `tools/fixtures/`.

## Data source and licence

Source: OpenStreetMap, read as OpenFreeMap's vector tiles (OpenMapTiles schema). Map data © OpenStreetMap contributors, licensed under ODbL. Any app that uses this data must show that attribution.

Known limits of this first version:
- Road topology is built from tile line ends snapped within about 2 m. Roads that cross without a shared end point are not joined. Turn restrictions are not stored yet.
- Area features near tile seams can appear twice. This is harmless for drawing and costs some size.
- Labels are stored in the file. The preview tool does not draw text; the app will draw labels.
