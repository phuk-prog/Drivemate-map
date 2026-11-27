# Drivemate-map (OSM-derived map data + Python build tooling)

Orientation so sessions don't need to rediscover the repo. Keep this file short.

## Where things are
- `tools/` — Python/shell pipeline; each `X.py` has a `test_X.py` beside it. `tests/` holds pilot-pack and tile-catalog tests.
- `.github/workflows/` — 19 workflows (UK source sync, tiles, routing, Valhalla, intelligence). Expensive; see below.
- `docs/` — start with `docs/REPOSITORY-WORKFLOW.md` and `docs/uk-map-data.md`; open others only when named.
- `requests/` — pilot-area JSON; `MANIFEST.json` — hashes the app pins against.

## Never read (large / binary / generated)
`overview/*.pmtiles`, `pilot/*.pmtiles`, `derived/*.dmap2`, `osm/*.osm`, `__pycache__/`. Inspect with `ls -l`, `head -c`, or the `*.provenance.json` / `*.report.json` files instead.

## Rules of thumb (token saving)
- Grep first, then Read with offset/limit; don't open whole tool scripts.
- Run one test: `python3 -m unittest tools.test_<name>` (or `python3 tests/test_pilot_pack.py`), not everything.
- Don't trigger or dispatch workflows to "check" something; the UK builds are multi-GB. Prefer local network-free tests.
- `python3 tools/build_pilot_pack.py --check` verifies the committed pilot pack.
- Routing/guidance data is candidate-only, not road-approved.
