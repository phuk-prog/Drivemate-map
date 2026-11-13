// Tests the road graph repair: roads that cross in the middle become junctions,
// while parallel roads, bridges and tunnels do not. Exits with code 1 on any failure.
// Usage: node tools/test-graph.mjs

import { joinCrossings, splitAtSharedVertices, dropSeamDuplicates, dropDuplicateEdges } from "./graph.mjs";
import { ownedRuns } from "./build-area.mjs";
import { validateDmap } from "./validate-dmap.mjs";

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

// 10. Tile ownership: a road that crosses a tile edge is cut there and kept by one tile only.
//     Coordinates are tile units (extent 4096). The right-hand tile sees the same road shifted by 4096.
{
  const EXT = 4096;
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const left = ownedRuns([[4000, 100], [4200, 100]], EXT);
  const right = ownedRuns([[4000 - EXT, 100], [4200 - EXT, 100]], EXT);
  check("road crossing a tile edge is kept by the left tile up to the edge", left.length === 1 && near(left[0][1][0], EXT) && near(left[0][1][1], 100), JSON.stringify(left));
  check("the right tile keeps the rest from the edge on", right.length === 1 && near(right[0][0][0], 0) && near(right[0][1][0], 4200 - EXT), JSON.stringify(right));

  // A road that only grazes the tile's corner region: both ends outside, the middle inside.
  const corner = ownedRuns([[-100, 200], [200, -100]], EXT);
  check("road through a tile corner (both ends outside) is kept", corner.length === 1 && corner[0].length === 2 && near(corner[0][0][0], 0) && near(corner[0][0][1], 100) && near(corner[0][1][0], 100) && near(corner[0][1][1], 0), JSON.stringify(corner));

  // A line lying exactly on the far edge belongs to the tile on its near side only.
  const farEdge = ownedRuns([[EXT, 0], [EXT, 500]], EXT);
  const nearEdge = ownedRuns([[0, 0], [0, 500]], EXT);
  check("line on the far edge is not kept by this tile", farEdge.length === 0, JSON.stringify(farEdge));
  check("line on the near edge is kept by this tile", nearEdge.length === 1 && nearEdge[0].length === 2);

  // A multi-point road crossing the edge keeps its inner points in order.
  const bent = ownedRuns([[4000, 0], [4050, 0], [4200, 0], [4300, 0]], EXT);
  check("bent road keeps its inner points up to the edge", bent.length === 1 && bent[0].length === 3 && near(bent[0][2][0], EXT), JSON.stringify(bent));

  // Random roads across two neighbouring tiles: each stretch is kept once, and together they
  // cover the road inside both tiles (sampled length check, 1% tolerance).
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; // Park-Miller, exact in doubles
  const lengthOf = (runs) => runs.reduce((s, r) => s + r.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - r[i - 1][0], p[1] - r[i - 1][1]) : 0), 0), 0);
  let worst = 0;
  let duplicated = 0;
  for (let k = 0; k < 300; k++) {
    const n = 2 + Math.floor(rnd() * 5);
    const pts = [];
    for (let i = 0; i < n; i++) pts.push([-1000 + rnd() * (2 * EXT + 2000), -1000 + rnd() * (EXT + 2000)]);
    // Tile A is [0, EXT] x [0, EXT]; tile B is the box shifted right by EXT.
    const inBox = (p, x0) => p[0] >= x0 && p[0] <= x0 + EXT && p[1] >= 0 && p[1] <= EXT;
    const a = ownedRuns(pts, EXT);
    const b = ownedRuns(pts.map(([x, y]) => [x - EXT, y]), EXT).map((r) => r.map(([x, y]) => [x + EXT, y]));
    // Sampled length of the road inside the union of both boxes (fine steps).
    let want = 0;
    for (let i = 1; i < pts.length; i++) {
      const [p, q] = [pts[i - 1], pts[i]];
      const steps = 2000;
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const m = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        if (inBox(m, 0) || inBox(m, EXT)) want += L / steps;
      }
    }
    const got = lengthOf(a) + lengthOf(b);
    if (want > 0) worst = Math.max(worst, Math.abs(got - want) / want);
    // A stretch counted twice would make got exceed want.
    if (got > want * 1.01 + 1) duplicated++;
  }
  check("random roads across a tile edge: every stretch kept once", duplicated === 0, `duplicated=${duplicated}`);
  check("random roads across a tile edge: covered length within 1%", worst <= 0.01, `worst=${(worst * 100).toFixed(2)}%`);
}

// 11. Seam duplicates with the same outer boundary but a different set of holes: one is kept,
//     the copy with more rings.
{
  const square = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];
  const hole = [[10000, 10000], [20000, 10000], [20000, 20000], [10000, 20000]];
  const polys = [
    { kind: 4, rings: [square(0, 0, 100000)] },
    { kind: 4, rings: [square(0, 0, 100000), hole] },
  ];
  const kept = dropSeamDuplicates(polys);
  check("same outer boundary is kept once", kept.length === 1, `kept=${kept.length}`);
  check("the copy with the hole is the one kept", kept.length === 1 && kept[0].rings.length === 2, `rings=${kept[0] && kept[0].rings.length}`);
  const reversed = dropSeamDuplicates([polys[1], polys[0]]);
  check("the hole copy is kept whichever comes first", reversed.length === 1 && reversed[0].rings.length === 2);

  // A copy with an extra part far away (a larger box) has the same outer ring: still one area.
  const far = [[500000, 500000], [510000, 500000], [510000, 510000]];
  const parts = dropSeamDuplicates([
    { kind: 1, rings: [square(0, 0, 100000)] },
    { kind: 1, rings: [square(0, 0, 100000), far] },
  ]);
  check("same outer ring with an extra far part is kept once", parts.length === 1 && parts[0].rings.length === 2, `kept=${parts.length}`);
}

// 12. Road ends within 2 m of each other join, measured on the ground at Stockport's latitude
//     (53.4 degrees). There one unit is about 1.11 cm north-south and about 0.66 cm east-west,
//     so 241 units east-west is about 1.60 m and 450 units is about 3.0 m.
{
  const L = 534000000; // lat 53.4
  const O = -22000000; // lon -2.2
  const EW_1P6 = 241;
  const EW_3 = 450;

  const joined = repair([
    road([[L - 2000, O], [L, O]]), // ends at P
    road([[L, O + EW_1P6], [L + 2000, O + EW_1P6]]), // starts 1.6 m east of P
  ]);
  check("road ends 1.6 m apart join", joined.nodes.length === 3 && joined.edges.length === 2, `nodes=${joined.nodes.length} edges=${joined.edges.length}`);
  check("joined road ends share one node", joined.edges.length === 2 && joined.edges[0].to === joined.edges[1].from, JSON.stringify(joined.edges.map((e) => [e.from, e.to])));

  // Each snapped edge must sit within the validator's EDGE_END_TOLERANCE (220 units per axis) of its node.
  const EDGE_END_TOLERANCE = 220; // tools/validate-dmap.mjs
  const endOffset = (e) => {
    const n = joined.nodes;
    const ends = [[e.points[0], n[e.from]], [e.points[e.points.length - 1], n[e.to]]];
    return Math.max(...ends.map(([p, q]) => Math.max(Math.abs(p[0] - q.lat), Math.abs(p[1] - q.lon))));
  };
  const worstEnd = Math.max(...joined.edges.map(endOffset));
  check("snapped road ends are within EDGE_END_TOLERANCE of their node", worstEnd <= EDGE_END_TOLERANCE, `worst=${worstEnd} units`);
  const map = {
    bbox: [L - 5000, O - 5000, L + 5000, O + 5000],
    nodes: joined.nodes,
    edges: joined.edges,
    lines: [],
    polygons: [],
    labels: [],
    restrictions: [],
    lanes: [],
    warnings: [],
  };
  const problems = validateDmap(map);
  check("snapped edges pass the validator", problems.length === 0, JSON.stringify(problems));

  const apart = repair([
    road([[L - 2000, O], [L, O]]),
    road([[L, O + EW_3], [L + 2000, O + EW_3]]), // 3 m east of P
  ]);
  check("road ends 3 m apart stay separate", apart.nodes.length === 4 && apart.edges.length === 2, `nodes=${apart.nodes.length} edges=${apart.edges.length}`);

  // A crossing at Stockport's latitude still makes one junction, not a missed join.
  const cross = repair([
    road([[L - 2000, O], [L + 2000, O]]),
    road([[L, O - 2000], [L, O + 2000]]),
  ]);
  check("crossing at Stockport latitude makes one junction", cross.nodes.length === 5 && cross.edges.length === 4 && cross.crossings === 1, `nodes=${cross.nodes.length} edges=${cross.edges.length} crossings=${cross.crossings}`);

  // Parallel roads 5 m apart (450 units north-south, 750 units east-west) do not meet.
  const parallelNS = repair([
    road([[L, O - 2000], [L, O + 2000]]),
    road([[L + 450, O - 2000], [L + 450, O + 2000]]),
  ]);
  check("parallel roads 5 m apart (north-south) stay separate", parallelNS.nodes.length === 4 && parallelNS.edges.length === 2, `nodes=${parallelNS.nodes.length} edges=${parallelNS.edges.length}`);
  const parallelEW = repair([
    road([[L - 2000, O], [L + 2000, O]]),
    road([[L - 2000, O + 750], [L + 2000, O + 750]]),
  ]);
  check("parallel roads 5 m apart (east-west) stay separate", parallelEW.nodes.length === 4 && parallelEW.edges.length === 2, `nodes=${parallelEW.nodes.length} edges=${parallelEW.edges.length}`);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall graph checks passed");
