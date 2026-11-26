# Map repository consolidation

Base: map V2 traffic signal candidate 5d4c5622fdc4ff23d5085503f369189d35dd5bbb, includes original compiler, unified geometry, intelligence and map V2 work. All historical branches remain intact until reviewed and archived. Do not promote experimental national/native routing or claim physical driving approval.

25 Nov 2026 route evidence (run 45697480405): three sample routes passed; Edinburgh–Livingston exhausted 350,000 expansions; Belfast–Lisburn expanded one state. Changes: skip departure nodes without usable outgoing edges; use bounded weighted A* for approximate travel-time routing (not optimality); retain restriction checks, failure bounds, and regression fixtures. Re-run all national samples; success is not assumed. Immutable dated graph releases and separate candidate and engineering-verified pointers prevent failed candidates being promoted. Evidence identity includes verifier hash, and downloads use the dated release, not a mutable alias. Existing app pins remain unchanged.

Next: validate current candidate on actual national graph, on-device performance, route legality, restricted access and physical navigation. Coordinate map and app pins with source, manifest and evidence digests. See app repository workflow contract.

## Follow-up: exact anchor failures remain
The 23:51 UTC national recheck (run 45724137205) reduced the first three searches to 37,402, 16,469 and 21,197 expansions, but Edinburgh still exhausted the budget and Belfast reached only two states. Alternative bounded road-anchor search now reports connected-road candidates and explicit unverified access gaps for diagnosis. A fallback result still fails release acceptance pending endpoint access review and equivalent Android implementation/device evidence. The fixed budget is shared; no restriction is removed. Existing approved pointers stay unchanged.

## Stability review

PR #21 runs read-only national routing candidate evidence on the exact dated
graph before merge. The diagnostic captures nearby road anchors and usable
departures without treating them as verified access. Successful desktop
journeys exceeding Android's 80,000 expansion ceiling cannot be promoted.
Device time and memory parity still require Android replay. Retain all
current app pins; do not raise resource bounds or weaken turn restrictions
to achieve a green check. Coordinate the matching app PR #36.

### Exact-anchor optimisation experiments
Failed national samples now run three exact-anchor queue weights (2.2, 3.3, 4.4), each independently capped at 80,000 expansions and 25 seconds. Reports expose alternate anchor diagnostics and exact-anchor experiments in the run log and artifact. Experiments cannot change acceptance or turn rules, and a desktop success is not Android time/memory or endpoint-access proof. Only choose a new production preview heuristic after comparing exact route lengths, times, and device replay.
