# Read-only map intelligence service
Run the verified database builder or reconstruct a checksum-verified candidate, then:
```sh
python3 tools/map_intelligence_service.py --db intelligence/map-intelligence.sqlite --report intelligence/coverage.json
```
The service binds localhost only; validates source metadata and the full database digest before startup. No writes, no TomTom information, no user location logging. API:
- GET /v1/meta — provenance and status.
- GET /v1/feature?type=w&id=123 — exact OSM identity, version, original tags and ordered geometry/member refs.
- GET /v1/nearby?lat=53&lon=-2&radius=100&limit=25 — bounded candidate search, not map matching. Radius is a bounding-box approximation; never use the first result for driving guidance.
- GET /v1/search?q=Example&limit=20 — name prefix search, not full postcode/address search.
A production deployment needs an authenticated HTTPS gateway, concurrency/rate limits, storage measurements and an atomic version switch. The Android routing engine must link to exact route edge identities, directional and conditional restrictions must be interpreted and tested separately. No edits, automatic submissions, or proprietary comparison retention. Raw map tags do not constitute legal driving guidance. ODbL attribution applies.
