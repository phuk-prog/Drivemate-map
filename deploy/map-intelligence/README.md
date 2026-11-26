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

## Exact-detail deployment

On the approved host, use a fresh output directory and a verified published graph:
```sh
bash deploy/map-intelligence/prepare-matched.sh \
  deploy/uk-valhalla/data/current/graph-manifest.json \
  deploy/uk-valhalla/data/current/tiles.tar matched-v2
python3 tools/independent_gateway.py \
  --graph-manifest deploy/uk-valhalla/data/current/graph-manifest.json \
  --graph-archive deploy/uk-valhalla/data/current/tiles.tar \
  --db matched-v2/intelligence/map-intelligence.sqlite \
  --report matched-v2/intelligence/coverage.json \
  --geometry-db matched-v2/geometry/map-v2.sqlite \
  --geometry-manifest matched-v2/geometry/manifest.json
```
All three datasets must share one immutable source. Gateway exposes /v2/roads alongside /v1 and routing, still on loopback only. Configure authenticated private TLS/VPN access with no request/location logs; use the configured HTTPS /route URL in the app. No public anonymous gateway, no unapproved hosting expenditure. Run the existing UK route smoke probes and the detailed geometry smoke command before any device acceptance. A missing or mismatched database fails closed. Retain the previous immutable deployment for rollback.
