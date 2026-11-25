# Map repository consolidation

Base: map V2 traffic signal candidate 5d4c5622fdc4ff23d5085503f369189d35dd5bbb, includes original compiler, unified geometry, intelligence and map V2 work. All historical branches remain intact until reviewed and archived. Do not promote experimental national/native routing or claim physical driving approval.

25 Nov 2026 route evidence (run 45697480405): three sample routes passed; Edinburgh–Livingston exhausted 350,000 expansions; Belfast–Lisburn expanded one state. Changes: skip departure nodes without usable outgoing edges; use bounded weighted A* for approximate travel-time routing (not optimality); retain restriction checks, failure bounds, and regression fixtures. Re-run all national samples; success is not assumed. Immutable dated graph releases and separate candidate and engineering-verified pointers prevent failed candidates being promoted. Evidence identity includes verifier hash, and downloads use the dated release, not a mutable alias. Existing app pins remain unchanged.

Next: validate current candidate on actual national graph, on-device performance, route legality, restricted access and physical navigation. Coordinate map and app pins with source, manifest and evidence digests. See app repository workflow contract.
