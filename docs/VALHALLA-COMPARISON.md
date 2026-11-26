# Testing DriveMate routing against Valhalla

DriveMate's routing is our own code. To find out where it goes wrong, we
compare it with [Valhalla](https://github.com/valhalla/valhalla), a mature
open-source router, used **only as a test yardstick**. Valhalla is never
shipped in, or linked into, DriveMate.

## How it works

`tools/compare_with_valhalla.py`:

1. Builds DriveMate's graph with the production importer
   (`build_uk_roads.load_osm` and `compile_dmtiles_uk.compile_graph`) and a
   Valhalla graph, both from the **same** OSM file.
2. Picks journeys: named real trips plus seeded random ones spread over
   1–5, 5–20, 20–60 and 60–160 km.
3. Routes each journey with DriveMate's Python mirror of `DmTileEngine`
   (`benchmark_dmtiles_uk.Archive.route`) and with Valhalla's car profile.
4. Compares the routes. It measures how much of each route runs along the
   other, the length ratio, and Valhalla's own travel time for DriveMate's
   route (by map-matching it), so a slower route is judged on one consistent
   time model.
5. Classifies each journey and records where the routes first split, with
   the OSM way, so it can be inspected.

| Verdict | Meaning | Look at |
|---|---|---|
| `match` | Same route | — |
| `equivalent` | Different roads, similar result | — |
| `ours_failed` | Valhalla routed, we did not | snapping, search limits, roads the importer dropped |
| `valhalla_failed` | We routed, Valhalla refused | access/legality on our route |
| `ours_slower` | Valhalla rates our route >10% slower than its own | speed model, missed faster roads |
| `ours_shorter` | Our route is >7% shorter | restrictions, access or one-ways we miss |
| `both_failed` | Neither routed | usually the journey endpoints |

A disagreement is not automatically our bug. Valhalla can be wrong, so check
the OSM data at the split point before changing code.

## Improve loop

```
pip install -r tools/valhalla-compare-requirements.txt
python3 tools/compare_with_valhalla.py --pbf north-east.osm.pbf --work /tmp/cmp \
    --report before.json --markdown before.md
# fix the cause in the importer, cost model or search
python3 tools/compare_with_valhalla.py --pbf north-east.osm.pbf --work /tmp/cmp \
    --baseline before.json --fail-on-regression --report after.json --markdown after.md
```

`--baseline` reruns the earlier report's exact journeys and lists every
journey whose verdict changed. `--fail-on-regression` exits non-zero if a
journey that used to agree no longer does. Our graph is rebuilt
automatically when the importer or compiler changes.

The **Compare DriveMate routing with Valhalla** workflow runs this on GitHub
weekly, on demand, and on pull requests that touch the router. If
`reports/valhalla-compare/<region>.json` is committed, it is used as the
baseline, so a pull request that makes routing worse fails.

## Limits

- This tests the Python mirror of the Android engine, not the APK. Keep the
  two in step.
- Agreement with Valhalla is not road-safety validation.
- Map data © OpenStreetMap contributors, ODbL 1.0.
