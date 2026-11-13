// Tests the road graph repair: roads that cross in the middle become junctions,
// while parallel roads, bridges and tunnels do not. Exits with code 1 on any failure.
// Usage: node tools/test-graph.mjs

import { joinCrossings, splitAtSharedVertices, dropSeamDuplicates, dropDuplicateEdges } from "./graph.mjs";

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

// 9. Duplicate roads and two-point loops are dropped; nodes are renumbered; roundabouts are kept.
{
  const nodesOf = (edges) => {
    const nodes = [];
    const id = new Map();
    const at = (p) => {
      const k = p.join(",");
      if (!id.has(k)) { id.set(k, nodes.length); nodes.push({ lat: p[0], lon: p[1] }); }
      return id.get(k);
    };
    const out = edges.map((e) => ({ ...e, from: at(e.points[0]), to: at(e.points[e.points.length - 1]) }));
    return { nodes, edges: out };
  };
  const a = [10000, 10000], b = [20000, 10000], c = [30000, 10000];
  const base = nodesOf([road([a, b, c])]);
  const same = nodesOf([road([a, b, c]), road([a, b, c])]);
  const r1 = dropDuplicateEdges(same);
  check("identical road is dropped", r1.edges.length === 1, `edges=${r1.edges.length}`);

  const rev = nodesOf([road([a, b, c]), road([c, b, a])]);
  check("reversed two-way duplicate is dropped", dropDuplicateEdges(rev).edges.length === 1);

  const revOneWay = nodesOf([road([a, b, c], 1), road([c, b, a], 1)]);
  check("reversed one-way roads are both kept", dropDuplicateEdges(revOneWay).edges.length === 2);

  const otherClass = nodesOf([road([a, b, c]), { roadClass: 3, flags: 0, points: [a, b, c] }]);
  check("same points with another road class are kept", dropDuplicateEdges(otherClass).edges.length === 2);

  const loop = nodesOf([road([a, b, c]), { roadClass: 6, flags: 0, points: [c, c] }]);
  const r2 = dropDuplicateEdges(loop);
  check("two-point loop is dropped", r2.edges.length === 1 && r2.edges[0].from !== r2.edges[0].to);
  check("unused nodes are removed", r2.nodes.length === 2, `nodes=${r2.nodes.length}`);

  const ring = [a, [20000, 20000], [10000, 20000], a];
  const round = nodesOf([road(ring)]);
  check("roundabout loop is kept", dropDuplicateEdges(round).edges.length === 1);
  check("base road is untouched", dropDuplicateEdges(base).edges.length === 1 && dropDuplicateEdges(base).nodes.length === 2);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall graph checks passed");
