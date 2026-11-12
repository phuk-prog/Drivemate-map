// Tests the OSM road graph builder with small hand-made road networks, and the loader with a
// real sample file. Usage: node tools/test-osm-roads.mjs [fixtures folder with test.pbf]

import { join } from "node:path";
import { buildRoadGraph, parseMaxspeed, onewayOf, EDGE_FLAG, RESTRICTION_KIND } from "./osm-roads.mjs";
import { loadOsmRoads } from "./load-osm.mjs";
import { writeDmap, readDmap } from "./dmap.mjs";

const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const BBOX = [-1, 50, 1, 52];

// Nodes on a small grid around 51,0.
const coords = new Map([
  [1, [51.0, -0.002]],
  [2, [51.0, 0.0]],
  [3, [51.0, 0.002]],
  [4, [51.002, 0.0]],
  [5, [51.004, 0.0]],
  [9, [60.0, 10.0]], // far outside the area
  [10, [60.001, 10.0]],
]);

// 1. T-junction: road A (1-2-3) is split at node 2, where road B (2-4) joins it.
{
  const g = buildRoadGraph({
    ways: [
      { id: 100, tags: { highway: "residential", name: "High Street" }, nodes: [1, 2, 3] },
      { id: 200, tags: { highway: "residential", name: "Mill Lane" }, nodes: [2, 4] },
    ],
    coords,
    bbox: BBOX,
  });
  check(g.edges.length === 3, `T-junction: ${g.edges.length} edges, expected 3`);
  check(g.nodes.length === 4, `T-junction: ${g.nodes.length} nodes, expected 4`);
  const junction = g.nodes.findIndex((n) => n.osmId === 2);
  check(g.edges.filter((e) => e.from === junction || e.to === junction).length === 3, "T-junction: all three edges meet at node 2");
  check(g.strings[g.edges[0].name] === "High Street", "T-junction: street name kept");
}

// 2. Reverse one-way is stored in its travel direction.
{
  const g = buildRoadGraph({ ways: [{ id: 1, tags: { highway: "primary", oneway: "-1" }, nodes: [1, 2, 3] }], coords, bbox: BBOX });
  const e = g.edges[0];
  check(g.edges.length === 1, "reverse one-way: one edge");
  check(g.nodes[e.from].osmId === 3 && g.nodes[e.to].osmId === 1, "reverse one-way: runs from node 3 to node 1");
  check((e.flags & EDGE_FLAG.ONEWAY) !== 0, "reverse one-way: one-way flag set");
}

// 3. Roundabouts and motorways are one-way even without an oneway tag.
check(onewayOf({ highway: "primary", junction: "roundabout" }) === 1, "roundabout implies one-way");
check(onewayOf({ highway: "motorway" }) === 1, "motorway implies one-way");
check(onewayOf({ highway: "residential" }) === 0, "residential is two-way by default");
{
  const g = buildRoadGraph({ ways: [{ id: 1, tags: { highway: "primary", junction: "roundabout" }, nodes: [1, 2, 3] }], coords, bbox: BBOX });
  check((g.edges[0].flags & EDGE_FLAG.ROUNDABOUT) !== 0, "roundabout flag set");
}

// 4. Speed limits.
check(parseMaxspeed("50") === 50, "maxspeed 50");
check(parseMaxspeed("30 mph") === 48, "maxspeed 30 mph is 48 km/h");
check(parseMaxspeed("GB:nsl_single") === 96, "UK national single carriageway is 96 km/h");
check(parseMaxspeed("none") === 0, "maxspeed none is unknown");
check(parseMaxspeed(undefined) === 0, "missing maxspeed is unknown");

// 5. Lanes and turn lanes.
{
  const g = buildRoadGraph({
    ways: [{ id: 1, tags: { highway: "primary", oneway: "yes", lanes: "2", "turn:lanes": "left|through;right" }, nodes: [1, 2] }],
    coords,
    bbox: BBOX,
  });
  check(g.edges[0].lanes === 2, "lanes = 2");
  check(g.strings[g.edges[0].turnLanesFwd] === "left|through;right", "turn lanes forward kept");
}

// 6. Turn restriction: no left turn from High Street onto Mill Lane at node 2.
{
  const g = buildRoadGraph({
    ways: [
      { id: 100, tags: { highway: "residential" }, nodes: [1, 2, 3] },
      { id: 200, tags: { highway: "residential" }, nodes: [2, 4, 5] },
    ],
    relations: [
      {
        id: 7,
        tags: { type: "restriction", restriction: "no_left_turn" },
        members: [
          { type: "way", ref: 100, role: "from" },
          { type: "node", ref: 2, role: "via" },
          { type: "way", ref: 200, role: "to" },
        ],
      },
    ],
    coords,
    bbox: BBOX,
  });
  check(g.restrictions.length === 1, `restriction: ${g.restrictions.length} found, expected 1`);
  const r = g.restrictions[0];
  if (r) {
    check(r.kind === RESTRICTION_KIND.NO, "restriction kind is no-turn");
    check(g.nodes[r.viaNode].osmId === 2, "restriction is at node 2");
    const toEdge = g.edges[r.toEdge];
    check(g.nodes[toEdge.from].osmId === 2 || g.nodes[toEdge.to].osmId === 2, "restriction leads onto Mill Lane at node 2");
  }
}

// 7. Roads entirely outside the area are dropped.
{
  const g = buildRoadGraph({ ways: [{ id: 1, tags: { highway: "primary" }, nodes: [9, 10] }], coords, bbox: BBOX });
  check(g.edges.length === 0, "road outside the area is dropped");
}

// 8. Footpaths and other non-car ways are not routable roads.
{
  const g = buildRoadGraph({ ways: [{ id: 1, tags: { highway: "footway" }, nodes: [1, 2] }], coords, bbox: BBOX });
  check(g.edges.length === 0, "footway is not a road");
}

// 9. A version 4 file keeps names, speed limits, lanes and restrictions through write and read.
{
  const g = buildRoadGraph({
    ways: [
      { id: 100, tags: { highway: "residential", name: "High Street", maxspeed: "20 mph", lanes: "2" }, nodes: [1, 2, 3] },
      { id: 200, tags: { highway: "residential", name: "Mill Lane" }, nodes: [2, 4, 5] },
    ],
    relations: [{ id: 7, tags: { type: "restriction", restriction: "only_straight_on" }, members: [
      { type: "way", ref: 100, role: "from" }, { type: "node", ref: 2, role: "via" }, { type: "way", ref: 200, role: "to" }] }],
    coords,
    bbox: BBOX,
  });
  const bytes = writeDmap({ bbox: [0, 0, 1, 1], nodes: g.nodes, edges: g.edges, lines: [], polygons: [], labels: [], strings: g.strings, restrictions: g.restrictions });
  const back = readDmap(bytes);
  check(back.version === 4, "round trip: version 4");
  check(back.edges.length === g.edges.length, "round trip: edge count");
  check(back.strings[back.edges[0].name] === "High Street", "round trip: street name");
  check(back.edges[0].maxspeed === 32, `round trip: 20 mph is 32 km/h, got ${back.edges[0].maxspeed}`);
  check(back.edges[0].lanes === 2, "round trip: lanes");
  check(back.restrictions.length === 1 && back.restrictions[0].kind === RESTRICTION_KIND.ONLY, "round trip: only-turn restriction");
}

// 10. Loader on a real sample file (central London): the one service road named "üßé€".
const fixtures = process.argv[2];
if (fixtures) {
  const data = loadOsmRoads(join(fixtures, "test.pbf"));
  const g = buildRoadGraph({ ...data, bbox: [-0.2, 51.4, 0.0, 51.6] });
  check(data.ways.length === 1, `loader: ${data.ways.length} roads, expected 1`);
  check(g.edges.length >= 1, "loader: the road became at least one edge");
  check(g.strings.includes("üßé€"), "loader: non-ASCII street name kept");
  console.log(`loader: ${data.ways.length} road, ${g.edges.length} edge(s), ${data.relations.length} restriction relation(s)`);
} else {
  console.log("loader check skipped (no fixtures folder given)");
}

if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("all OSM road graph checks passed");
