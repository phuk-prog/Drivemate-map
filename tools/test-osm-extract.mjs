// Tests the OSM extract reader and extractor on a tiny .osm.pbf file that this test
// writes itself, so it needs no download. Exits with code 1 on any failure.
// Usage: node tools/test-osm-extract.mjs

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { extractFromPbf } from "./osm-extract.mjs";
import { RESTRICTION_NO, WARNING_SPEED_CAMERA, WARNING_LEVEL_CROSSING, WARNING_ROADWORKS } from "./dmap.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL ${name} ${detail}`);
  }
};

// ---- A small protobuf and PBF writer, only for this test ----
const varint = (n) => {
  const bytes = [];
  while (n >= 128) {
    bytes.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Buffer.from(bytes);
};
const zig = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);
const tag = (f, w) => varint(f * 8 + w);
const lenField = (f, buf) => Buffer.concat([tag(f, 2), varint(buf.length), buf]);
const varField = (f, n) => Buffer.concat([tag(f, 0), varint(n)]);
const packedField = (f, nums) => lenField(f, Buffer.concat(nums.map(varint)));
const deltaZigzag = (nums) => {
  let prev = 0;
  return nums.map((n) => {
    const d = n - prev;
    prev = n;
    return zig(d);
  });
};

// A string table that hands out indexes for the strings used in one block.
function strings() {
  const list = [""];
  return {
    id(s) {
      let i = list.indexOf(s);
      if (i < 0) {
        i = list.length;
        list.push(s);
      }
      return i;
    },
    encode: () => lenField(1, Buffer.concat(list.map((s) => lenField(1, Buffer.from(s, "utf8"))))),
  };
}

const block = (st, groups) => Buffer.concat([st.encode(), ...groups.map((g) => lenField(2, g))]);

function frame(type, data, compress = true) {
  const blob = compress
    ? Buffer.concat([varField(2, data.length), lenField(3, deflateSync(data))])
    : lenField(1, data);
  const header = Buffer.concat([lenField(1, Buffer.from(type)), varField(3, blob.length)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([len, header, blob]);
}

// Coordinates are in 1e-7 degrees, which is the file's default granularity of 100 nanodegrees.
const nodes = [
  { id: 1, lat: 515000000, lon: -1000000 }, // centre
  { id: 2, lat: 515000000, lon: -1010000 }, // west
  { id: 3, lat: 515000000, lon: -990000 }, // east
  { id: 4, lat: 514990000, lon: -1000000 }, // south
  { id: 5, lat: 515010000, lon: -1000000 }, // north
  { id: 6, lat: 520000000, lon: -1000000 }, // far away, outside the box
  { id: 7, lat: 520000000, lon: -1010000 }, // far away, outside the box
  { id: 8, lat: 515005000, lon: -1005000, tags: [["highway", "speed_camera"]] }, // speed camera, in the box
  { id: 9, lat: 514995000, lon: -995000, tags: [["railway", "level_crossing"]] }, // level crossing, in the box
  { id: 10, lat: 515008000, lon: -990000 }, // roadworks way, first node
  { id: 11, lat: 515009000, lon: -985000 }, // roadworks way, second node
  { id: 12, lat: 520000000, lon: -990000, tags: [["highway", "speed_camera"]] }, // speed camera, far away
];

function nodeBlock() {
  const st = strings();
  // keys_vals: key and value indexes for each node in turn, with a 0 ending each node.
  const keysVals = [];
  for (const n of nodes) {
    for (const [k, v] of n.tags || []) keysVals.push(st.id(k), st.id(v));
    keysVals.push(0);
  }
  const dense = Buffer.concat([
    packedField(1, deltaZigzag(nodes.map((n) => n.id))),
    packedField(8, deltaZigzag(nodes.map((n) => n.lat))),
    packedField(9, deltaZigzag(nodes.map((n) => n.lon))),
    packedField(10, keysVals),
  ]);
  return block(st, [lenField(2, dense)]);
}

function wayBlock() {
  const st = strings();
  const way = (id, refs, tags) =>
    Buffer.concat([
      varField(1, id),
      packedField(2, tags.map(([k]) => st.id(k))),
      packedField(3, tags.map(([, v]) => st.id(v))),
      packedField(8, deltaZigzag(refs)),
    ]);
  const ways = [
    way(10, [2, 1, 3], [["highway", "primary"], ["turn:lanes", "left|through|right"]]), // lane way, in the box
    way(11, [4, 1], [["highway", "residential"]]), // restriction from way
    way(12, [1, 2], [["highway", "residential"]]), // restriction to way
    way(13, [6, 7], [["highway", "primary"], ["turn:lanes:forward", "left|right"], ["oneway", "yes"]]), // far away
    way(14, [10, 11], [["highway", "construction"]]), // road under construction, in the box
  ];
  return block(st, [Buffer.concat(ways.map((w) => lenField(3, w)))]);
}

function relationBlock() {
  const st = strings();
  const relation = (id, tags, members) =>
    Buffer.concat([
      varField(1, id),
      packedField(2, tags.map(([k]) => st.id(k))),
      packedField(3, tags.map(([, v]) => st.id(v))),
      packedField(8, members.map((m) => st.id(m.role))),
      packedField(9, deltaZigzag(members.map((m) => m.id))),
      packedField(10, members.map((m) => m.type)),
    ]);
  const rels = [
    // A simple no-left-turn: from way 11, via node 1, to way 12.
    relation(20, [["type", "restriction"], ["restriction", "no_left_turn"]], [
      { role: "from", id: 11, type: 1 },
      { role: "via", id: 1, type: 0 },
      { role: "to", id: 12, type: 1 },
    ]),
    // A restriction through a via way: not supported, so skipped.
    relation(21, [["type", "restriction"], ["restriction", "only_straight_on"]], [
      { role: "from", id: 11, type: 1 },
      { role: "via", id: 10, type: 1 },
      { role: "to", id: 12, type: 1 },
    ]),
    // Not a restriction.
    relation(22, [["type", "route"], ["route", "bus"]], [{ role: "", id: 10, type: 1 }]),
  ];
  return block(st, [Buffer.concat(rels.map((r) => lenField(4, r)))]);
}

const file = Buffer.concat([
  frame("OSMHeader", lenField(4, Buffer.from("OsmSchema-V0.6"))),
  frame("OSMData", nodeBlock()),
  frame("OSMData", wayBlock(), false), // stored raw, to cover that path
  frame("OSMData", relationBlock()),
]);

// Not under data/cache: the map builder treats every folder there as a set of map tiles.
const dir = join(ROOT, "data", "test-tmp");
await mkdir(dir, { recursive: true });
const path = join(dir, "tiny.osm.pbf");
await writeFile(path, file);

// The box is [minLon, minLat, maxLon, maxLat] in degrees, around the crossroads.
const { restrictions, laneWays, warnings, stats } = await extractFromPbf(path, [-0.2, 51.4, 0.0, 51.6]);

// 1. The simple restriction is found, with coordinates read from the delta-coded nodes.
check("one simple restriction is extracted", restrictions.length === 1, JSON.stringify(restrictions));
if (restrictions.length === 1) {
  const r = restrictions[0];
  check("restriction kind is no", r.kind === RESTRICTION_NO);
  check("via node is the centre", r.via[0] === 515000000 && r.via[1] === -1000000, JSON.stringify(r.via));
  check("from way is the point before the via node, then the via node", JSON.stringify(r.from) === JSON.stringify([[514990000, -1000000], [515000000, -1000000]]), JSON.stringify(r.from));
  check("to way is the via node, then the point after", JSON.stringify(r.to) === JSON.stringify([[515000000, -1000000], [515000000, -1010000]]), JSON.stringify(r.to));
}

// 2. The lane way inside the box is kept, with its tags and all its points. The far one is dropped.
check("one lane way is kept", laneWays.length === 1, JSON.stringify(laneWays.map((w) => w.tags)));
if (laneWays.length === 1) {
  check("lane text is kept", laneWays[0].tags["turn:lanes"] === "left|through|right");
  check("lane way keeps all three points", laneWays[0].geom.length === 3);
  check("lane way has no oneway tag", laneWays[0].oneway === "");
}

// 3. The counts show what was skipped, and why.
check("both restriction relations were seen", stats.restrictionRelations === 2, JSON.stringify(stats));
check("only the simple one was usable", stats.restrictionsSimple === 1, JSON.stringify(stats));
check("the far lane way was found but dropped for being outside the box", stats.laneWaysFound === 2 && stats.laneWaysOutsideBox === 1, JSON.stringify(stats));

// 4. Warnings: speed camera, level crossing and roadworks in the box; the far camera is dropped.
{
  const kinds = warnings.map((w) => w.kind).sort();
  check("three warnings are extracted", warnings.length === 3, JSON.stringify(warnings));
  check("warning kinds are camera, crossing and roadworks", JSON.stringify(kinds) === JSON.stringify([WARNING_SPEED_CAMERA, WARNING_LEVEL_CROSSING, WARNING_ROADWORKS].sort()), JSON.stringify(kinds));
  const cam = warnings.find((w) => w.kind === WARNING_SPEED_CAMERA);
  check("speed camera keeps its position", cam && cam.lat === 515005000 && cam.lon === -1005000, JSON.stringify(cam));
  const works = warnings.find((w) => w.kind === WARNING_ROADWORKS);
  check("roadworks is the middle node of the road", works && works.lat === 515009000 && works.lon === -985000, JSON.stringify(works));
  check("the far speed camera is not counted", stats.warningsSpeedCamera === 1, JSON.stringify(stats));
}

// 5. A box that does not contain the crossroads drops everything.
{
  const empty = await extractFromPbf(path, [10, 10, 11, 11]);
  check("a box away from the crossroads gives nothing", empty.restrictions.length === 0 && empty.laneWays.length === 0 && empty.warnings.length === 0, JSON.stringify(empty.stats));
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall OSM extract checks passed");
