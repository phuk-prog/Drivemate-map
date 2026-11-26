# DriveMate vs Valhalla

Source: `26c36f8b531c`, 66 journeys, agreement score **100.0%** (match + equivalent, excluding journeys neither engine could route).

Baseline score 87.9% -> now 100.0% (+12.1).

| Verdict | Count | What to check |
|---|---|---|
| match | 44 | Same route (within tolerance). |
| equivalent | 22 | Different roads, but similar length and Valhalla rates our route about as fast. |
| ours_failed | 0 | Valhalla found a route; DriveMate did not. Check snapping, search limits and roads the importer dropped. |
| valhalla_failed | 0 | DriveMate found a route Valhalla refused. Check access/legality on our route: we may use a road cars cannot. |
| ours_slower | 0 | Valhalla rates our route clearly slower than its own. Check our speed model and missed faster roads. |
| ours_shorter | 0 | Our route is much shorter and Valhalla could not match it to drivable roads. Check restrictions, access or one-ways we miss. |
| both_failed | 0 | Neither engine routed. Usually bad journey endpoints, not an engine bug. |

## Changed since baseline

| Journey | Before | Now |
|---|---|---|
| Newcastle to Durham | ours_slower | match |
| Gateshead to Newcastle Airport | ours_failed | equivalent |
| random 1-5 km #8 | ours_slower | match |
| random 5-20 km #14 | ours_slower | match |
| random 5-20 km #15 | ours_failed | equivalent |
| random 20-60 km #6 | ours_slower | match |
| random 20-60 km #8 | equivalent | match |
| random 20-60 km #15 | ours_failed | match |
| random 60-160 km #6 | match | equivalent |
| random 60-160 km #13 | ours_failed | match |

Engineering comparison only. Not a road-safety validation of either engine. Map data © OpenStreetMap contributors, ODbL 1.0.
