# UK map intelligence database (experimental)

The complete, immutable Geofabrik UK PBF is still the master source and preserves every original OSM object and tag. This separate indexed SQLite product makes navigation-related features directly queryable without changing the existing routing or PMTiles release. It contains every original tag on selected road/transport/place/POI/building/address/barrier/sign/access/boundary entities, original object IDs, versions, ordered way-node IDs and coordinates, relation member IDs and roles. It deliberately excludes OSM contributor account metadata from the index. Relations retain members, not preassembled geometry; unmatched/missing coordinates are flagged. All data is ODbL 1.0 with attribution and immutable source checksum.

Coverage reports break down mapped attribute presence by highway class, way count and complete geometry length: lane counts, directional turn lanes, lane destinations, lane-change restrictions, access, signed speed, conditional restrictions, road names/references, structures, surface, vehicle dimensions, tolls, parking and more. These are not validated lane recommendations, legal speed limits, traffic status or actual physical lane widths. The full PBF retains non-indexed features too.

The map-first Android provider should consume a future authenticated read-only endpoint built on this data and the Valhalla routing graph. Never use nearby geometry alone to identify a lane or impose a restriction. No TomTom data enters this database. No automatic OpenStreetMap changes. Independent corrections require a verified source and review of the correct OSM object/direction; keep the private survey notes out of this public repository until the user authorises publication.

## Build
Use the existing verified UK PBF restoration script, then run:
```sh
python3 -m pip install osmium
python3 tools/uk_restore_for_tiles.py --dest cache
python3 tools/build_map_intelligence.py --source cache/united-kingdom.osm.pbf --source-tag "$TAG" --source-sha256 "$SHA" --scope uk --out intelligence
```
The branch workflow builds the pinned Wells pilot, then a separate full UK audit/index candidate. It uploads checksummed compressed parts and coverage evidence as temporary Actions artifacts only. No production release or latest alias is changed. Full UK resource and performance measurements are pending. Production ingestion, address search indexing, lane connectivity interpretation, service deployment, independent correction submission, update scheduling, pack format validation on Android and device road validation remain separate tasks.
