# UK-wide offline car routing (experimental)

The app's PMTiles files display the map; **they cannot calculate a route**.
The `build-uk-routing.yml` job derives a separate UK car road network from
the same verified Geofabrik OpenStreetMap PBF, covering England, Scotland,
Wales and Northern Ireland. Isle of Man/Channel Islands are outside this extract.

The custom streaming Python builder preserves the original OSM node IDs across
national boundaries, keeps directed one-way road segments, OSM turn restrictions,
estimated traversal time, road names, major-road/toll/ferry flags and populated
place-name anchors. Unknown access rules, conditional-access roads and uncertain
turns are excluded or restricted rather than silently guessed open. This can
cause legitimate journeys to fail, and **does not** prove road legality.

The SQLite network is gzip-compressed, divided into release parts no larger than
850 MB, and accompanied by `uk-routing-manifest.json`. This contains the
source PBF SHA-256, whole decompressed database SHA-256, compressed SHA-256 and
SHA-256 for each ordered part. Downloads and imports must verify all checksums.
Published builds are under dated `routes-*` and `routes-latest` GitHub Releases.

Developer build:

```sh
python3 -m pip install osmium
python3 tools/build_uk_roads.py --source cache/united-kingdom.osm.pbf \
  --source-tag "$SOURCE_TAG" --source-sha256 "$SOURCE_SHA256" --out routing
```

A full UK graph is potentially many gigabytes when decompressed, needs phone
storage and performance measurements, and has not been road validated. No live
traffic, legally verified speed limits, HGV restrictions, current closures or
physical-device acceptance is claimed.

Data © OpenStreetMap contributors, ODbL 1.0.

The build manifest records a `builder_sha256` fingerprint. The three daily
source checks rebuild routing data if the importer changes even if Geofabrik's
PBF does not. Dated routing Releases include the builder fingerprint in the
tag to avoid overwriting the previous build. A previous full UK Release from
22 November 2026 had a name-normalisation defect; do **not** use a pack without
the corrected builder fingerprint, as place and street searches cannot work.
