// Tests turn restrictions: Overpass parsing, matching to roads, and the DMAP round trip.
// Uses a small crossroads with no network access. Exits with code 1 on any failure.
// Usage: node tools/test-restrictions.mjs

import { joinCrossings, splitAtSharedVertices } from "./graph.mjs";
import { parseOverpass, matchRestrictions } from "./restrictions.mjs";
import { writeDmap, readDmap, RESTRICTION_NO, RESTRICTION_ONLY } from "./dmap.mjs";

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

// A plus-shaped crossroads: road A runs east-west, road B runs north-south, no shared ends.
const roads = [
  road([[0, -10000], [0, 10000]]), // A, west to east
  road([[-10000, 0], [10000, 0]]), // B, south to north
];
const crossed = joinCrossings(roads);
const { nodes, edges } = splitAtSharedVertices(crossed.edges);

const endsAt = (e, lat, lon) => {
  const a = e.points[0];
  const b = e.points[e.points.length - 1];
  return (a[0] === lat && a[1] === lon) || (b[0] === lat && b[1] === lon);
};
const centre = nodes.findIndex((n) => n.lat === 0 && n.lon === 0);
check("crossroads has a centre node", centre >= 0, `nodes=${JSON.stringify(nodes)}`);

// 1. A no-left-turn: travel north on B (arriving from the south), turn west onto A.
//    Heading north, west is to the left.
{
  const record = {
    kind: RESTRICTION_NO,
    from: [[-10000, 0], [0, 0]], // B, south part
    via: [0, 0],
    to: [[0, 0], [0, -10000]], // A, west part
  };
  const r = matchRestrictions(nodes, edges, [record]);
  check("no-left-turn is matched", r.matched.length === 1, `matched=${r.matched.length} unmatched=${JSON.stringify(r.unmatched)}`);
  if (r.matched.length === 1) {
    const m = r.matched[0];
    check("restriction is at the centre node", m.via === centre);
    check("restriction kind is no", m.kind === RESTRICTION_NO);
    check("from edge is the south part of B", endsAt(edges[m.from], -10000, 0) && endsAt(edges[m.from], 0, 0));
    check("to edge is the west part of A", endsAt(edges[m.to], 0, -10000) && endsAt(edges[m.to], 0, 0));
  }
}

// 2. An only-straight-on: from the south on B, the only allowed turn is straight north.
{
  const record = {
    kind: RESTRICTION_ONLY,
    from: [[-10000, 0], [0, 0]],
    via: [0, 0],
    to: [[0, 0], [10000, 0]],
  };
  const r = matchRestrictions(nodes, edges, [record]);
  check("only-straight-on is matched", r.matched.length === 1 && r.matched[0].kind === RESTRICTION_ONLY, JSON.stringify(r));
  if (r.matched.length === 1) {
    check("only-straight-on goes north", endsAt(edges[r.matched[0].to], 10000, 0) && endsAt(edges[r.matched[0].to], 0, 0));
  }
}

// 3. A via node far from any junction is not matched.
{
  const record = {
    kind: RESTRICTION_NO,
    from: [[-10000, 50000], [0, 50000]],
    via: [0, 50000],
    to: [[0, 50000], [0, 60000]],
  };
  const r = matchRestrictions(nodes, edges, [record]);
  check("far-away via node is unmatched", r.matched.length === 0 && r.unmatched.noVia === 1, JSON.stringify(r.unmatched));
}

// 4. A restriction whose to-way runs back the way the from-way came is not matched
//    (a U-turn is not a turn between two different roads).
{
  const record = {
    kind: RESTRICTION_NO,
    from: [[-10000, 0], [0, 0]],
    via: [0, 0],
    to: [[0, 0], [-10000, 0]],
  };
  const r = matchRestrictions(nodes, edges, [record]);
  check("U-turn restriction is not matched to the same road", r.matched.length === 0, JSON.stringify(r));
}

// 5. Overpass parsing: simple restrictions are kept, others are skipped.
{
  const json = {
    elements: [
      {
        type: "relation",
        tags: { type: "restriction", restriction: "no_left_turn" },
        members: [
          { type: "way", role: "from", geometry: [{ lat: -0.001, lon: 0 }, { lat: 0, lon: 0 }] },
          { type: "node", role: "via", lat: 0, lon: 0 },
          { type: "way", role: "to", geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: -0.001 }] },
        ],
      },
      {
        type: "relation",
        tags: { type: "restriction", restriction: "only_straight_on" },
        members: [
          { type: "way", role: "from", geometry: [{ lat: -0.001, lon: 0 }, { lat: 0, lon: 0 }] },
          { type: "way", role: "via", geometry: [{ lat: 0, lon: 0 }, { lat: 0.001, lon: 0.001 }] },
          { type: "way", role: "to", geometry: [{ lat: 0, lon: 0 }, { lat: 0.001, lon: 0 }] },
        ],
      },
      { type: "relation", tags: { type: "route" }, members: [] },
    ],
  };
  const p = parseOverpass(json);
  check("parse keeps the simple no-turn restriction", p.records.length === 1 && p.records[0].kind === RESTRICTION_NO, JSON.stringify(p));
  check("parse skips via-ways and non-restrictions", p.skipped === 2, `skipped=${p.skipped}`);
  check("parse converts to fixed-point units", p.records[0] && p.records[0].via[0] === 0 && p.records[0].from[0][0] === -10000, JSON.stringify(p.records[0]));
}

// 6. DMAP round trip keeps the restrictions, and the file reads back as version 4.
{
  const restrictions = [
    { kind: RESTRICTION_NO, from: 0, to: 1, via: centre },
    { kind: RESTRICTION_ONLY, from: 2, to: 3, via: centre },
  ];
  const bytes = writeDmap({ bbox: [0, 0, 0, 0], nodes, edges, lines: [], polygons: [], labels: [], restrictions });
  const back = readDmap(bytes);
  check("DMAP round trip keeps restrictions", JSON.stringify(back.restrictions) === JSON.stringify(restrictions), JSON.stringify(back.restrictions));
  check("DMAP round trip keeps edges", back.edges.length === edges.length);
  const v3 = Buffer.from(bytes);
  v3.writeUInt16LE(3, 4);
  // Version 5 files end with the restrictions section and an empty lanes count (4 bytes).
  // Dropping the lanes count, the restriction records and the restriction count leaves a version 3 layout.
  const noSection = readDmap(v3.subarray(0, v3.length - (4 + restrictions.length * 13 + 4)));
  check("version 3 files still read, with no restrictions", noSection.restrictions.length === 0);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall restriction checks passed");
