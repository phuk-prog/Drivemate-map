# drivemate-map-data

OpenStreetMap-derived road data for Drivemate (ODbL 1.0).

This repository holds Drivemate's map **data** separately from the
rights-reserved application code, so the ODbL licence and its share-alike
obligation apply cleanly to the data alone. This repository is publicly
readable; publication does not itself clear all source-data, attribution or
redistribution obligations for a derived database.

## Contents

| Path | What it is |
|---|---|
| `requests/*.json` | Bounded pilot areas to fetch (name, bbox, licence, attribution) |
| `osm/*.osm` + `*.provenance.json` | Raw Overpass extracts with endpoint, query, `osm_base` timestamp, SHA-256 |
| `derived/*.dmap2` + `*.report.json` | Drivemate DMAP2 road databases produced by the fail-closed importer (derived database, ODbL) |
| `MANIFEST.json` | SHA-256 and size of every data file; the Drivemate app repo pins against these hashes |
| `tools/fetch_osm_extract.py` | Downloader used by the workflow |
| `.github/workflows/fetch-osm.yml` | Fetches requested extracts on GitHub Actions and commits them with provenance |

## UK-wide map data (GitHub-only)

The [UK-wide map-data pipeline](docs/uk-map-data.md) downloads the full
Geofabrik/OpenStreetMap UK PBF covering England, Scotland, Wales and Northern
Ireland. GitHub Actions automatically checks Geofabrik **three times each day**
(03:43, 11:43 and 19:43 UTC), storing validated changed snapshots as **GitHub Release
assets** (split into files smaller than 2 GiB).
Git history remains small. A manifest records the part checksums, whole-map
SHA-256, source timestamp, licence and provenance. Only complete, verified
releases are published; an interrupted run leaves the last release available.
This temporary GitHub solution refreshes from full source snapshots; the
original S3/diff experiment remains available but is not enabled by default.
No routing or app functions are changed by this pipeline.

### Refreshing the displayed UK map tiles

The `Build offline tiles` workflow reconstructs the newest verified GitHub
Release source PBF from its checksummed parts and rebuilds the UK/England/
Scotland/Wales/Northern Ireland PMTiles datasets. It runs after a successful
UK source-data publication **only when the source has changed or the last
map-tile publication is missing/stale**; it also runs after map-build code
changes or manually. A no-change check runs tests but skips expensive data
downloads and tile rebuilding. Failed tile publications are retried on the
next scheduled check. Dated PMTiles releases remain available for rollback
and the `live` branch receives the new catalog. This is map-data production only, not routing development.

See [the UK map-data documentation](docs/uk-map-data.md) for limitations,
validation and storage costs.

## Current pilot

- **Wells, Somerset, UK**: bbox 51.198,-2.668 → 51.222,-2.622.
- **Extract:** fetched 2026-11-18 (`osm_base` 2026-11-18T18:14:20Z). It contains 965 ways and 4 restriction relations.
- **Derived database:** `osm-pilot-wells-2026-11-18`, with 5,274 nodes and 5,386 road records. It is CAR-only. Real-road guidance is **not approved**; it is used for automated research and emulator tests only.

## Detailed pilot map pack (M2)

`pilot/wells-z12-16.pmtiles` (about 250 KB, zoom 12-16) is the detailed offline
map pack for the Wells pilot area. `tools/build_pilot_pack.py` builds it, with
the standard library only and byte-for-byte reproducibly, from the pinned
`osm/wells-places-2026-11-19.osm` extract. It holds roads with names and refs,
named places and tagged buildings. The source has no water or land cover, so
the pack has none. `python3 tools/build_pilot_pack.py --check` confirms the
committed file matches a fresh build. NOT FOR DRIVING.

## Updating

1. Add or edit a file in `requests/` on a branch other than `main`, and push it.
2. The workflow fetches the extract and commits it, with provenance, to that branch.
3. Regenerate `derived/` with Drivemate's `tools/osm_to_dmap2.py`, and refresh `MANIFEST.json`.
4. Review the diff before merging.

Attribution: © OpenStreetMap contributors, ODbL 1.0.

## Interchangeable UK routing engine data (candidate)

The Android app can select a configured Valhalla HTTPS routing service or its
previous imported SQLite graph. A separate, **not yet road-validated** candidate
pipeline prepares native Valhalla tiles for a future on-device Valhalla Mobile
integration or a hosted Valhalla service:

- tools/build_valhalla_graph.sh checks the exact whole-UK OSM PBF digest and
  source release identity then invokes an immutable Valhalla 3.8.3 Docker image.
- tools/package_valhalla_tiles.py splits the native tiles.tar extract into
  SHA-256-checked parts smaller than GitHub's per-asset limit, and writes a
  builder/version/provenance manifest.
- The Build UK Valhalla workflow runs network-free packaging tests on PRs.
  The expensive full-UK build is **manual initially** to measure RAM, time,
  routing coverage and asset sizes before putting it on scheduled updates.
  Multi-gigabyte graph Releases are published as **drafts** first. The
  `verify_valhalla_release.py` step checks every GitHub asset name, uploaded
  state and byte size against the source-pinned manifest before publication.
  Missing or corrupt uploads must remain unpublished and cannot replace a
  previously available dated snapshot.

Native Valhalla tiles are a different format from both DriveMate SQLite
routing data and Planetiler PMTiles display data. **No Valhalla tile Release
or Android Valhalla Mobile integration is claimed until actually verified.**
A GitHub Release of data is not a hosted routing service; deploying and
operating a UK server requires separate infrastructure. © OpenStreetMap
contributors (ODbL 1.0); Valhalla source MIT.
