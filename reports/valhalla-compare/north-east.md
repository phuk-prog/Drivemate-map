# DriveMate vs Valhalla

Source: `26c36f8b531c`, 66 journeys, agreement score **59.1%** (match + equivalent, excluding journeys neither engine could route).

Baseline score 36.4% -> now 59.1% (+22.7).

| Verdict | Count | What to check |
|---|---|---|
| match | 23 | Same route (within tolerance). |
| equivalent | 16 | Different roads, but similar length and Valhalla rates our route about as fast. |
| ours_failed | 23 | Valhalla found a route; DriveMate did not. Check snapping, search limits and roads the importer dropped. |
| valhalla_failed | 0 | DriveMate found a route Valhalla refused. Check access/legality on our route: we may use a road cars cannot. |
| ours_slower | 4 | Valhalla rates our route clearly slower than its own. Check our speed model and missed faster roads. |
| ours_shorter | 0 | Our route is much shorter and Valhalla could not match it to drivable roads. Check restrictions, access or one-ways we miss. |
| both_failed | 0 | Neither engine routed. Usually bad journey endpoints, not an engine bug. |

## Disagreements to investigate

| Journey | Verdict | Ours | Valhalla | Where routes split |
|---|---|---|---|---|
| Sunderland to Hexham | ours_failed | no route (Disconnected or resource bound) | 57.89 km / 39.1 min |  |
| Middlesbrough to Berwick | ours_failed | no route (Disconnected or resource bound) | 161.11 km / 98.1 min |  |
| Darlington to Alnwick | ours_failed | no route (Disconnected or resource bound) | 114.77 km / 70.6 min |  |
| Gateshead to Newcastle Airport | ours_failed | no route (No nearby eligible directed road node) | 19.3 km / 24.9 min |  |
| random 5-20 km #15 | ours_failed | no route (Disconnected or resource bound) | 10.43 km / 14.3 min |  |
| random 20-60 km #11 | ours_failed | no route (Disconnected or resource bound) | 65.92 km / 51.6 min |  |
| random 20-60 km #13 | ours_failed | no route (Disconnected or resource bound) | 53.78 km / 36.7 min |  |
| random 20-60 km #14 | ours_failed | no route (Disconnected or resource bound) | 85.58 km / 57.9 min |  |
| random 20-60 km #15 | ours_failed | no route (Disconnected or resource bound) | 62.44 km / 40.9 min |  |
| random 60-160 km #1 | ours_failed | no route (Disconnected or resource bound) | 110.33 km / 65.7 min |  |
| random 60-160 km #2 | ours_failed | no route (Disconnected or resource bound) | 83.36 km / 55.6 min |  |
| random 60-160 km #4 | ours_failed | no route (Disconnected or resource bound) | 102.99 km / 72.2 min |  |
| random 60-160 km #5 | ours_failed | no route (Disconnected or resource bound) | 132.19 km / 80.6 min |  |
| random 60-160 km #6 | ours_failed | no route (Disconnected or resource bound) | 89.45 km / 57.3 min |  |
| random 60-160 km #7 | ours_failed | no route (Disconnected or resource bound) | 101.47 km / 72.4 min |  |
| random 60-160 km #8 | ours_failed | no route (Disconnected or resource bound) | 82.42 km / 48.8 min |  |
| random 60-160 km #9 | ours_failed | no route (Disconnected or resource bound) | 154.79 km / 97.6 min |  |
| random 60-160 km #10 | ours_failed | no route (Disconnected or resource bound) | 109.51 km / 68.5 min |  |
| random 60-160 km #11 | ours_failed | no route (Disconnected or resource bound) | 85.92 km / 51.7 min |  |
| random 60-160 km #12 | ours_failed | no route (Disconnected or resource bound) | 123.82 km / 80.4 min |  |
| random 60-160 km #13 | ours_failed | no route (Disconnected or resource bound) | 74.65 km / 47.9 min |  |
| random 60-160 km #14 | ours_failed | no route (Disconnected or resource bound) | 117.91 km / 74.4 min |  |
| random 60-160 km #15 | ours_failed | no route (Disconnected or resource bound) | 113.94 km / 69.7 min |  |
| Newcastle to Durham | ours_slower | 35.061 km / 24.9 min | 29.74 km / 20.6 min | [54.788552,-1.546637](https://www.openstreetmap.org/?mlat=54.788552&mlon=-1.546637#map=17/54.788552/-1.546637) way [4811073](https://www.openstreetmap.org/way/4811073) after 26.92 km |
| random 1-5 km #8 | ours_slower | 3.963 km / 4.6 min | 3.01 km / 4.0 min | [55.009626,-1.573427](https://www.openstreetmap.org/?mlat=55.009626&mlon=-1.573427#map=17/55.009626/-1.573427) way [860298938](https://www.openstreetmap.org/way/860298938) after 0.76 km |
| random 5-20 km #14 | ours_slower | 14.462 km / 11.8 min | 12.38 km / 10.8 min | [54.852355,-1.578992](https://www.openstreetmap.org/?mlat=54.852355&mlon=-1.578992#map=17/54.852355/-1.578992) way [57389008](https://www.openstreetmap.org/way/57389008) after 0.47 km |
| random 20-60 km #6 | ours_slower | 35.397 km / 25.2 min | 37.49 km / 24.4 min | [54.580197,-1.445373](https://www.openstreetmap.org/?mlat=54.580197&mlon=-1.445373#map=17/54.580197/-1.445373) way [318747541](https://www.openstreetmap.org/way/318747541) after 0.06 km |

## Changed since baseline

| Journey | Before | Now |
|---|---|---|
| Newcastle to Durham | ours_failed | ours_slower |
| Hartlepool to Consett | ours_failed | match |
| random 1-5 km #1 | ours_shorter | equivalent |
| random 1-5 km #2 | ours_shorter | equivalent |
| random 1-5 km #7 | ours_shorter | equivalent |
| random 1-5 km #14 | ours_failed | equivalent |
| random 5-20 km #1 | ours_shorter | equivalent |
| random 5-20 km #2 | ours_shorter | equivalent |
| random 5-20 km #4 | ours_shorter | equivalent |
| random 5-20 km #5 | ours_shorter | equivalent |
| random 5-20 km #10 | ours_shorter | equivalent |
| random 5-20 km #12 | ours_shorter | equivalent |
| random 20-60 km #2 | ours_failed | match |
| random 20-60 km #7 | ours_shorter | equivalent |
| random 20-60 km #9 | ours_failed | match |
| random 20-60 km #10 | ours_failed | equivalent |

Engineering comparison only. Not a road-safety validation of either engine. Map data © OpenStreetMap contributors, ODbL 1.0.
