// Tests lane guidance: Overpass parsing, matching to roads by direction, and the DMAP
// round trip (version 5, with restrictions). No network needed.
// Exits with code 1 on any failure.
// Usage: node tools/test-lanes.mjs

import { splitAtSharedVertices } from "./graph.mjs";
import { parseLaneOverpass, matchLanes, reverseLaneText, validLaneText } from "./lanes.mjs";
import { writeDmap, readDmap, RESTRICTION_NO } from "./dmap.mjs";

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL ${name} ${detail}`);
  }
};

// Coordinates are [lat, lon] in 1e-7 degree units. 10000 units is about 110 m.
// A road running east (lon increasing) along lat 0, split into edges at its end points.
const eastRoad = { roadClass: 3, flags: 0, points: [[0, -10000], [0, 0], [0, 10000]] };
const { nodes, edges } = splitAtSharedVertices([eastRoad]);

// The OSM way for the same road, in the same direction (east), with the same geometry.
const wayEast = {
  tags: { "turn:lanes": "left|through|through|right" },
  oneway: "",
  geom: [[0, -10000], [0, 10000]],
};

// 1. A way running the same way as an edge gives that edge its turn:lanes text.
{
  const r = matchLanes(edges, [wayEast]);
  check("edge in the way's direction gets turn:lanes", r.lanes.length === edges.length && r.lanes.every((l) => l.text === "left|through|through|right"), JSON.stringify(r));
}

// 2. A reversed edge on a two-way road gets turn:lanes:backward, and no forward text.
{
  const reversed = [{ roadClass: 3, flags: 0, points: [[0, 10000], [0, 0], [0, -10000]], from: 0, to: 1 }];
  const wayTwoWay = {
    tags: { "turn:lanes:forward": "through|through", "turn:lanes:backward": "left|right" },
    oneway: "",
    geom: [[0, -10000], [0, 10000]],
  };
  const r = matchLanes(reversed, [wayTwoWay]);
  check("reversed edge on a two-way road gets turn:lanes:backward", r.lanes.length === 1 && r.lanes[0].text === "left|right", JSON.stringify(r));
}

// 3. A oneway=-1 road: the edge runs against the way. Plain turn:lanes is in the way's
// direction, so it is reversed and mirrored into travel order.
{
  const reversed = [{ roadClass: 3, flags: 1, points: [[0, 10000], [0, -10000]], from: 0, to: 1 }];
  const g = [[0, -10000], [0, 10000]];
  let r = matchLanes(reversed, [{ tags: { "turn:lanes": "left|through|slight_right;right" }, oneway: "-1", geom: g }]);
  check("oneway=-1 plain turn:lanes is reversed and mirrored", r.lanes.length === 1 && r.lanes[0].text === "left;slight_left|through|right", JSON.stringify(r));
  r = matchLanes(reversed, [{ tags: { "turn:lanes:backward": "left|right", "turn:lanes": "x|y" }, oneway: "-1", geom: g }]);
  check("oneway=-1 prefers :backward, used as it stands", r.lanes.length === 1 && r.lanes[0].text === "left|right", JSON.stringify(r));
  r = matchLanes(reversed, [{ tags: { "turn:lanes:forward": "left|right" }, oneway: "-1", geom: g }]);
  check("oneway=-1 with only :forward is left unmatched", r.lanes.length === 0 && r.stats.oneWayAgainstWay === 1, JSON.stringify(r.stats));
  r = matchLanes(reversed, [{ tags: { "turn:lanes": "left|weird_value" }, oneway: "-1", geom: g }]);
  check("oneway=-1 with an unknown lane value is left unmatched", r.lanes.length === 0 && r.stats.oneWayAgainstWay === 1, JSON.stringify(r.stats));
  const twoWayEdge = [{ roadClass: 3, flags: 0, points: [[0, 10000], [0, -10000]], from: 0, to: 1 }];
  r = matchLanes(twoWayEdge, [{ tags: { "turn:lanes": "left|right" }, oneway: "-1", geom: g }]);
  check("two-way edge does not take a oneway=-1 way's lanes", r.lanes.length === 0, JSON.stringify(r.stats));
}

// 3b. reverseLaneText.
{
  check("reverse: order and left/right swap", reverseLaneText("left|through|through|right") === "left|through|through|right");
  check("reverse: slight and merge values", reverseLaneText("sharp_left|slight_left|merge_to_right|none||reverse") === "reverse||none|merge_to_left|slight_right|sharp_right");
  check("reverse: values inside a lane", reverseLaneText("left;through|through;right") === "left;through|through;right");
  check("reverse: lane with several values", reverseLaneText("through;right|right") === "left|left;through");
  check("reverse: unknown value gives null", reverseLaneText("left|banana") === null);
}

// 3c. An edge against a oneway=yes way is another carriageway: no match, and the way on the
// parallel carriageway with the right direction wins.
{
  const westEdge = [{ roadClass: 3, flags: 1, points: [[40, 10000], [40, -10000]], from: 0, to: 1 }];
  const eastWay = { tags: { "turn:lanes": "left|right" }, oneway: "yes", geom: [[0, -10000], [0, 10000]] };
  const westWay = { tags: { "turn:lanes": "through|through" }, oneway: "yes", geom: [[40, 10000], [40, -10000]] };
  let r = matchLanes(westEdge, [eastWay]);
  check("edge against a oneway=yes way gets nothing", r.lanes.length === 0 && r.stats.noWay === 1, JSON.stringify(r.stats));
  r = matchLanes(westEdge, [eastWay, westWay]);
  check("parallel carriageways: the one running the same way wins", r.lanes.length === 1 && r.lanes[0].text === "through|through", JSON.stringify(r));
}

// 3d. Nearly equal two-way candidates with different texts are left unmatched; a clearly nearer one wins.
{
  const e = [{ roadClass: 3, flags: 0, points: [[0, -10000], [0, 0], [0, 10000]], from: 0, to: 1 }];
  const wa = { tags: { "turn:lanes": "left|right" }, oneway: "", geom: [[-20, -10000], [-20, 10000]] };
  const wb = { tags: { "turn:lanes": "through|through" }, oneway: "", geom: [[20, -10000], [20, 10000]] };
  let r = matchLanes(e, [wa, wb]);
  check("two equally close ways with different lanes: unmatched", r.lanes.length === 0 && r.stats.twoWayMatchedAmbiguous === 1, JSON.stringify(r.stats));
  const wc = { tags: { "turn:lanes": "through|through" }, oneway: "", geom: [[600, -10000], [600, 10000]] };
  r = matchLanes(e, [wa, wc]);
  check("a clearly nearer way wins", r.lanes.length === 1 && r.lanes[0].text === "left|right", JSON.stringify(r));
}

// 3d2. Two consecutive ways meeting near the edge's middle: the one covering more of the edge wins;
// a way covering less than half of the edge does not match.
{
  const e = [{ roadClass: 3, flags: 0, points: [[0, 0], [0, 20000]], from: 0, to: 1 }];
  const A = { tags: { "turn:lanes": "left|right" }, oneway: "", geom: [[0, 0], [0, 12000]] };
  const B = { tags: { "turn:lanes": "through|through" }, oneway: "", geom: [[0, 12000], [0, 30000]] };
  let r = matchLanes(e, [A, B]);
  check("consecutive ways: the one covering more of the edge wins", r.lanes.length === 1 && r.lanes[0].text === "left|right", JSON.stringify(r));
  const tiny = { tags: { "turn:lanes": "left|right" }, oneway: "", geom: [[0, 9000], [0, 11000]] };
  r = matchLanes(e, [tiny]);
  check("a way covering under half the edge does not match", r.lanes.length === 0 && r.stats.noWay === 1, JSON.stringify(r.stats));
}

// 3e. Missing-direction stats: reversed edge on a two-way road with only :forward, and the opposite.
{
  const g = [[0, -10000], [0, 10000]];
  const rev = [{ roadClass: 3, flags: 0, points: [[0, 10000], [0, -10000]], from: 0, to: 1 }];
  let r = matchLanes(rev, [{ tags: { "turn:lanes:forward": "left|right" }, oneway: "", geom: g }]);
  check("reversed edge, only :forward: unmatched and counted", r.lanes.length === 0 && r.stats.reversedEdgeOnlyForwardTag === 1 && r.stats.noTagForDirection === 1, JSON.stringify(r.stats));
  const fwd = [{ roadClass: 3, flags: 1, points: [[0, -10000], [0, 10000]], from: 0, to: 1 }];
  r = matchLanes(fwd, [{ tags: { "turn:lanes:backward": "left|right" }, oneway: "yes", geom: g }]);
  check("oneway=yes with only :backward: unmatched and counted", r.lanes.length === 0 && r.stats.onlyBackwardTag === 1, JSON.stringify(r.stats));
}

// 3f. Lane text that is not valid OSM grammar is dropped and counted, never attached.
{
  const g = [[0, -10000], [0, 10000]];
  const fwd = [{ roadClass: 3, flags: 0, points: [[0, -10000], [0, 10000]], from: 0, to: 1 }];
  let r = matchLanes(fwd, [{ tags: { "turn:lanes": "throughthrough||right" }, oneway: "", geom: g }]);
  check("invalid lane text is dropped and counted", r.lanes.length === 0 && r.stats.invalidLaneText === 1 && r.stats.noTagForDirection === 0, JSON.stringify(r.stats));
  r = matchLanes(fwd, [{ tags: { "turn:lanes": "left||through;right|reversible" }, oneway: "", geom: g }]);
  check("valid text with an empty lane is kept", r.lanes.length === 1, JSON.stringify(r.stats));
  check("validLaneText rejects spaces, empty values and 13 lanes", !validLaneText("left; through") && !validLaneText("left;|right") && !validLaneText(Array(13).fill("left").join("|")) && validLaneText("none|"));
}

// 4. A way far away (about 100 m off) does not match.
{
  const farWay = { tags: { "turn:lanes": "left|right" }, oneway: "", geom: [[10000, -10000], [10000, 10000]] };
  const r = matchLanes(edges, [farWay]);
  check("way far from the road does not match", r.lanes.length === 0 && r.stats.noWay === edges.length, JSON.stringify(r.stats));
}

// 5. A way at right angles (a cross street) does not match the road.
{
  const cross = { tags: { "turn:lanes": "left|right" }, oneway: "", geom: [[-10000, 0], [10000, 0]] };
  const r = matchLanes(edges, [cross]);
  check("cross street at right angles does not match", r.lanes.length === 0, JSON.stringify(r.stats));
}

// 6. Overpass parsing keeps lane tags, skips other ways, and converts to fixed-point units.
{
  const json = {
    elements: [
      {
        type: "way",
        tags: { highway: "primary", "turn:lanes": "left|through|right", oneway: "yes" },
        geometry: [{ lat: 0, lon: -0.001 }, { lat: 0, lon: 0.001 }],
      },
      { type: "way", tags: { highway: "primary" }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }] },
      { type: "relation", tags: { type: "restriction" }, members: [] },
    ],
  };
  const p = parseLaneOverpass(json);
  check("parse keeps the lane way", p.ways.length === 1 && p.ways[0].tags["turn:lanes"] === "left|through|right", JSON.stringify(p));
  check("parse keeps oneway", p.ways[0] && p.ways[0].oneway === "yes");
  check("parse skips ways without lane tags", p.skipped === 2, `skipped=${p.skipped}`);
  check("parse converts to fixed-point units", p.ways[0] && p.ways[0].geom[1][1] === 10000, JSON.stringify(p.ways[0]));
}

// 7. DMAP version 5 round trip keeps lanes and restrictions, and a version 4 file still reads.
{
  const lanes = [{ edge: 0, text: "left|through|right" }, { edge: 1, text: "through|through" }];
  const restrictions = [{ kind: RESTRICTION_NO, from: 0, to: 1, via: 1 }];
  const bytes = writeDmap({ bbox: [0, 0, 0, 0], nodes, edges, lines: [], polygons: [], labels: [], restrictions, lanes });
  const back = readDmap(bytes);
  check("DMAP round trip keeps lanes", JSON.stringify(back.lanes) === JSON.stringify(lanes), JSON.stringify(back.lanes));
  check("DMAP round trip keeps restrictions", JSON.stringify(back.restrictions) === JSON.stringify(restrictions));

  // A version 4 file has restrictions but no lanes or warnings section. Its last 12 bytes are the
  // lane count, warning count and speed limit count, so drop them and set the version to 4.
  const v4 = Buffer.from(writeDmap({ bbox: [0, 0, 0, 0], nodes, edges, lines: [], polygons: [], labels: [], restrictions, lanes: [] }));
  const v4cut = v4.subarray(0, v4.length - 12);
  v4cut.writeUInt16LE(4, 4);
  const old = readDmap(v4cut);
  check("version 4 file reads, with no lanes", old.lanes.length === 0 && old.restrictions.length === 1, JSON.stringify(old.restrictions));

  // Warnings round trip, and a version 5 file (no warnings section) still reads.
  const warnings = [{ kind: 1, lat: 515005000, lon: -1005000 }, { kind: 3, lat: 515009000, lon: -985000 }];
  const withWarnings = writeDmap({ bbox: [0, 0, 0, 0], nodes, edges, lines: [], polygons: [], labels: [], restrictions, lanes, warnings });
  check("DMAP round trip keeps warnings", JSON.stringify(readDmap(withWarnings).warnings) === JSON.stringify(warnings));
  const v5 = Buffer.from(withWarnings);
  const v5cut = v5.subarray(0, v5.length - (4 + warnings.length * 9 + 4));
  v5cut.writeUInt16LE(5, 4);
  const v5read = readDmap(v5cut);
  check("version 5 file reads, with lanes and no warnings", v5read.warnings.length === 0 && v5read.lanes.length === 2, JSON.stringify(v5read.lanes));
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall lane checks passed");
