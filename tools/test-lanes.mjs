// Tests lane guidance: Overpass parsing, matching to roads by direction, and the DMAP
// round trip (version 5, with restrictions). No network needed.
// Exits with code 1 on any failure.
// Usage: node tools/test-lanes.mjs

import { splitAtSharedVertices } from "./graph.mjs";
import { parseLaneOverpass, matchLanes } from "./lanes.mjs";
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

// 3. A one-way road that runs against the way is skipped and counted.
{
  const reversed = [{ roadClass: 3, flags: 1, points: [[0, 10000], [0, -10000]], from: 0, to: 1 }];
  const wayOneWay = { tags: { "turn:lanes": "left|through" }, oneway: "-1", geom: [[0, -10000], [0, 10000]] };
  const r = matchLanes(reversed, [wayOneWay]);
  check("one-way road against the way gets no lanes", r.lanes.length === 0 && r.stats.oneWayAgainstWay === 1, JSON.stringify(r.stats));
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

  // A version 4 file has restrictions but no lanes section. Its last 4 bytes are the
  // lane count, so drop them and set the version to 4.
  const v4 = Buffer.from(writeDmap({ bbox: [0, 0, 0, 0], nodes, edges, lines: [], polygons: [], labels: [], restrictions, lanes: [] }));
  const v4cut = v4.subarray(0, v4.length - 4);
  v4cut.writeUInt16LE(4, 4);
  const old = readDmap(v4cut);
  check("version 4 file reads, with no lanes", old.lanes.length === 0 && old.restrictions.length === 1, JSON.stringify(old.restrictions));
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall lane checks passed");
