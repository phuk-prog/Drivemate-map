# DriveMate independent services: deployment preparation
Use a Linux host with approved storage and bandwidth. Restore the verified full UK graph and intelligence database from the SAME immutable Geofabrik source digest. Do not expose raw Valhalla or SQLite services directly.
1. Run existing deploy/uk-valhalla/install.sh with the matching graph release. Run its Compose service and all five HTTP smoke probes.
2. Verify the intelligence coverage manifest and database digest; run tools/map_intelligence_service.py on localhost:8010. Run /v1/meta and /v1/ways smoke queries.
3. Deploy a private HTTPS gateway with access control, rate limits, request size limits and no location logging. Route /route and /trace_attributes to localhost:8002, /v1/* to localhost:8010. Serve /v1/graph-source as JSON {"source_sha256":"<verified actual graph source digest>"} from installed graph manifest; fail gateway startup if it differs from index source. Never advertise an unverified digest.
4. Configure a trusted Photon service (separate index/import and endpoint); do not use public demo infrastructure as a production backend.
5. Run Android end-to-end tests including independent route, GPS loss, mismatched data digest, no TomTom key, and route comparison.
Regional attribute packs may be generated with tools/pack_regional_intelligence.py. They do not include complete relation geometry or native offline route graphs; cannot be used to infer access, restrictions or safe navigation.
TomTom live tiles remain separate. Integrating commercial traffic speeds into Valhalla requires licensed feed, edge mapping, expiry, closure and false-positive checks. No paid hosting provisioned or traffic feed copied. No change submission endpoint: independent user survey notes must remain private until approved for OSM or compatible source submission.

## Matched-source gateway
The graph installer now retains the verified manifest beside the graph archive.
Restore the exact graph source rather than the latest PBF; for example:
```sh
graph=deploy/uk-valhalla/data/current/graph-manifest.json
tag=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["source_tag"])' "$graph")
sha=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["source_sha256"])' "$graph")
python3 tools/uk_restore_for_tiles.py --dest cache-matched --source-tag "$tag" --source-sha256 "$sha"
python3 tools/build_map_intelligence.py --source cache-matched/united-kingdom.osm.pbf --source-tag "$tag" --source-sha256 "$sha" --scope uk --out intelligence-matched
python3 tools/independent_gateway.py --graph-manifest "$graph" --graph-archive deploy/uk-valhalla/data/current/tiles.tar --db intelligence-matched/map-intelligence.sqlite --report intelligence-matched/coverage.json
```
The gateway verifies both archives and identical immutable source provenance, exposes graph-source itself, bounds requests, and forwards only allowlisted car routing calls to localhost:8002. Keep the graph and index immutable for the service lifetime; stop gateway and routing service before changing the graph or index. Loopback port 8011 requires an external TLS/authenticated proxy or private VPN for Android access. No external host is created by this commit. Photon remains separately deployed.

## Nationwide V2 display geometry (optional)
The gateway accepts `--geometry-db /path/map-v2.sqlite --geometry-manifest /path/manifest.json`. It verifies the complete database digest and rejects startup unless source tag and source digest match the installed graph/index pair. Android requests `GET /v2/roads?bbox=west,south,east,north&source=<matching sha>` on the same configured HTTPS host. The endpoint returns actual E7 source geometry and mapped points within the existing size and density bounds. If no V2 database is installed the endpoint returns 503; it cannot invent data. Do not widen the bounds or silently truncate route ways to make a dense request succeed.

The 25 November national V2 candidate artifact (Actions run 45788134657, artifact 15113702730) must be restored from its checksummed parts, fully verified and paired with a graph and intelligence database built from that exact source. The older 22 November Valhalla release is NOT a matching source. No production host is provisioned or verified here. An owner-approved Linux host, capacity measurement, matching graph/index, private HTTPS gateway, access and rate limits, full UK regional probes and Android end-to-end checks are deployment gates. Keep the current graph and offline fallback unchanged. Do not distribute this database as an APK asset.
