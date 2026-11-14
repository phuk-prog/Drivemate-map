// Tests the road names and signposts matcher. Needs no download.
// Usage: node tools/test-roadnames.mjs

import { matchRoadNames, matchSignposts } from "./roadnames.mjs";

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL ${name} ${detail}`);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Test coordinates and edges. Coordinates are 1e-7 degree units; 100 units is about 1 m.
const edge = (pts, flags = 0) => ({ from: 0, to: 1, roadClass: 3, flags, points: pts });
const way = (extra) => ({ geom: [[0, -10000], [0, 10000]], ...extra });

// 1. Road names matching
{
  const east = edge([[0, -10000], [0, 0], [0, 10000]]); // two-way edge along the way
  const roadNameWay = way({ name: "Main Street" });
  let r = matchRoadNames([east], [roadNameWay]);
  check("road name is matched", same(r.roadNames, [{ edge: 0, name: "Main Street" }]) && r.stats.matched === 1, JSON.stringify(r));

  // No matching ways
  r = matchRoadNames([east], []);
  check("no road name ways gives nothing", r.roadNames.length === 0 && r.stats.noWay === 1);

  // Multiple ways with same name - should match
  r = matchRoadNames([east], [way({ name: "Main Street" }), way({ name: "Main Street", geom: [[0, -10000], [0, 10000]] })]);
  check("multiple ways with same name match the nearest", r.roadNames.length === 1, JSON.stringify(r));

  // Way too far away
  const far = way({ name: "Far Road", geom: [[2000, -10000], [2000, 10000]] });
  r = matchRoadNames([east], [far]);
  check("a way 20 m away does not match", r.roadNames.length === 0 && r.stats.noWay === 1, JSON.stringify(r.stats));

  // Multiple different names at same distance - ambiguous (e.g., parallel roads)
  // Both ways are 100 units away (about 1m) perpendicular to the edge
  r = matchRoadNames([east], [way({ name: "Main Street", geom: [[100, -10000], [100, 10000]] }), way({ name: "Side Road", geom: [[-100, -10000], [-100, 10000]] })]);
  check("two ways at same distance with different names: unmatched, ambiguous", r.roadNames.length === 0 && r.stats.ambiguous === 1, JSON.stringify(r));

  // Crossing way (wrong direction)
  const cross = way({ name: "Cross Road", geom: [[-10000, 0], [10000, 0]] });
  r = matchRoadNames([east], [cross]);
  check("a crossing road does not match (direction)", r.roadNames.length === 0, JSON.stringify(r.stats));

  // Multiple edges
  const west = edge([[0, 10000], [0, 0], [0, -10000]]); // two-way edge against the way
  r = matchRoadNames([east, west], [way({ name: "Main Street" })]);
  check("both edges with same way get the name", r.roadNames.length === 2, JSON.stringify(r));
}

// 2. Signposts matching
{
  const east = edge([[0, -10000], [0, 0], [0, 10000]]);
  const signpostWay = way({ signpost: "City Centre" });
  let r = matchSignposts([east], [signpostWay]);
  check("signpost is matched", same(r.signposts, [{ edge: 0, signpost: "City Centre" }]) && r.stats.matched === 1, JSON.stringify(r));

  // No matching ways
  r = matchSignposts([east], []);
  check("no signpost ways gives nothing", r.signposts.length === 0 && r.stats.noWay === 1);

  // Multiple ways with same signpost - should match
  r = matchSignposts([east], [way({ signpost: "Exit 12" }), way({ signpost: "Exit 12", geom: [[0, -10000], [0, 10000]] })]);
  check("multiple ways with same signpost match the nearest", r.signposts.length === 1, JSON.stringify(r));

  // Way too far away
  const far = way({ signpost: "Far Exit", geom: [[2000, -10000], [2000, 10000]] });
  r = matchSignposts([east], [far]);
  check("a way 20 m away does not match", r.signposts.length === 0 && r.stats.noWay === 1, JSON.stringify(r.stats));

  // Multiple different signposts at same distance - ambiguous
  r = matchSignposts([east], [way({ signpost: "City Centre", geom: [[100, -10000], [100, 10000]] }), way({ signpost: "Airport", geom: [[-100, -10000], [-100, 10000]] })]);
  check("two ways at same distance with different signposts: unmatched, ambiguous", r.signposts.length === 0 && r.stats.ambiguous === 1, JSON.stringify(r));

  // Crossing way (wrong direction)
  const cross = way({ signpost: "Perp Road", geom: [[-10000, 0], [10000, 0]] });
  r = matchSignposts([east], [cross]);
  check("a crossing road does not match (direction)", r.signposts.length === 0, JSON.stringify(r.stats));
}

// 3. Empty edges and ways
{
  let r = matchRoadNames([], [way({ name: "Test" })]);
  check("no edges gives nothing", r.roadNames.length === 0);

  r = matchSignposts([], [way({ signpost: "Test" })]);
  check("no edges gives nothing for signposts", r.signposts.length === 0);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall roadnames checks passed");
