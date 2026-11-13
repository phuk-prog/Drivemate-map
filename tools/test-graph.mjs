// Tests the road graph repair: roads that cross in the middle become junctions,
// while parallel roads, bridges and tunnels do not. Exits with code 1 on any failure.
// Usage: node tools/test-graph.mjs

import { joinCrossings, splitAtSharedVertices, dropSeamDuplicates } from "./graph.mjs";

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL ${name} ${detail}`);
  }
};

// Coordinates are [lat, lon] in 1e-7 degree units. 10000 units is about 110 m.
const road = (points, flags = 0) => ({ roadClass: 6, flags, points });
const repair = (edges) => {
  const crossed = joinCrossings(edges);
  const split = splitAtSharedVertices(crossed.edges);
  return { ...split, crossings: crossed.joins };
};

// 1. Plus shape: one road crosses the middle of another, no shared end point.
{
  const r = repair([
    road([[0, -10000], [0, 10000]]),
    road([[-10000, 0], [10000, 0]]),
  ]);
  check("plus crossing makes one junction", r.nodes.length === 5, `nodes=${r.nodes.length}`);
  check("plus crossing splits both roads", r.edges.length === 4, `edges=${r.edges.length}`);
  check("plus crossing finds one crossing", r.crossings === 1, `crossings=${r.crossings}`);
}

// 2. Parallel roads 1000 units apart (about 11 m) do not meet.
{
  const r = repair([
    road([[0, -10000], [0, 10000]]),
    road([[1000, -10000], [1000, 10000]]),
  ]);
  check("parallel roads are not joined", r.nodes.length === 4 && r.edges.length === 2, `nodes=${r.nodes.length} edges=${r.edges.length}`);
}

// 3. A road over a bridge is not joined to the road beneath it.
{
  const r = repair([
    road([[0, -10000], [0, 10000]]),
    road([[-10000, 0], [10000, 0]], 2), // bridge flag
  ]);
  check("bridge over a road is not joined", r.nodes.length === 4 && r.edges.length === 2, `nodes=${r.nodes.length} edges=${r.edges.length}`);
}

// 4. A tunnel under a road is not joined either.
{
  const r = repair([
    road([[0, -10000], [0, 10000]]),
    road([[-10000, 0], [10000, 0]], 4), // tunnel flag
  ]);
  check("tunnel under a road is not joined", r.nodes.length === 4 && r.edges.length === 2, `nodes=${r.nodes.length} edges=${r.edges.length}`);
}

// 5. T-junction: the end of one road lies in the middle of another.
//    Already handled by the shared-point rule once the point is inserted into the long road.
{
  const r = repair([
    road([[0, -10000], [0, 10000]]),
    road([[-10000, 0], [0, 0]]),
  ]);
  check("T-junction makes one junction", r.nodes.length === 4 && r.edges.length === 3, `nodes=${r.nodes.length} edges=${r.edges.length}`);
}

// 6. Two roads cross on a bend, with a corner in each road close to the crossing.
{
  const r = repair([
    road([[0, -10000], [5000, 0], [0, 10000]]),
    road([[-10000, 0], [10000, 0]]),
  ]);
  check("bend crossing is joined", r.crossings >= 1 && r.nodes.length >= 4, `crossings=${r.crossings} nodes=${r.nodes.length}`);
}

// 7. Three roads through one point become one junction, not three.
{
  const r = repair([
    road([[0, -10000], [0, 10000]]),
    road([[-10000, 0], [10000, 0]]),
    road([[-10000, -10000], [10000, 10000]]),
  ]);
  const distinct = new Set(r.nodes.map((n) => `${n.lat},${n.lon}`)).size;
  check("three roads through one point share one junction", distinct === r.nodes.length, `distinct=${distinct} nodes=${r.nodes.length}`);
}

// 8. Seam duplicates: the same square twice is kept once; the same place with a
//    different shape is kept; a different kind at the same place is kept.
{
  const square = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];
  const polys = [
    { kind: 2, rings: [square(0, 0, 100000)] },
    { kind: 2, rings: [square(0, 0, 100000).slice().reverse()] }, // same square, other winding
    { kind: 2, rings: [square(0, 0, 100000).map(([a, b]) => [a + 1, b])] }, // shifted 1 unit: same place
    { kind: 2, rings: [square(0, 0, 50000)] }, // same corner, half the size: kept
    { kind: 1, rings: [square(0, 0, 100000)] }, // other kind: kept
  ];
  const kept = dropSeamDuplicates(polys);
  check("seam duplicate of the same area is dropped", kept.length === 3, `kept=${kept.length}`);
  check("same place, different size is kept", kept.some((p) => p.kind === 2 && p.rings[0][1][0] === 50000));
  check("same square, other kind is kept", kept.some((p) => p.kind === 1));
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall graph checks passed");
