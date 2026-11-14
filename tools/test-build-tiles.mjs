// Run: node --test tools/test-build-tiles.mjs
// Tests the tile builder: classification, Web Mercator, clipping, tile content, the .dmtile container,
// and an end-to-end build from a small .osm.pbf file that this test writes itself (no download).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  classify, mercator, tileRange, clipPolygon, clipLine, tileContent, tooSmall,
  buildTiles, packContainer, readContainer, buildRegion, EXTENT,
} from "./build-tiles.mjs";
import { decodeTile } from "./mvt.mjs";

// ---- classify ----

test("classify: buildings need a closed way", () => {
  assert.equal(classify({ building: "yes" }, true).layer, "building");
  assert.equal(classify({ building: "yes" }, false), null);
  assert.equal(classify({ building: "no" }, true), null);
});
test("classify: water areas and waterways", () => {
  assert.equal(classify({ natural: "water" }, true).layer, "water");
  assert.equal(classify({ natural: "water" }, false), null, "open natural=water is not an area");
  assert.equal(classify({ waterway: "river" }, false).minZoom, 7);
  assert.equal(classify({ waterway: "stream" }, false).minZoom, 12);
  assert.equal(classify({ waterway: "weir" }, false), null);
});
test("classify: landuse and leisure areas, closed only", () => {
  assert.equal(classify({ landuse: "forest" }, true).cls, "forest");
  assert.equal(classify({ leisure: "park" }, true).cls, "park");
  assert.equal(classify({ natural: "wood" }, true).cls, "wood");
  assert.equal(classify({ landuse: "forest" }, false), null);
  assert.equal(classify({ landuse: "unknown_thing" }, true), null);
});
test("classify: roads by class, with name, and paths from zoom 15", () => {
  const r = classify({ highway: "primary", name: "Market St" }, false);
  assert.equal(r.layer, "road");
  assert.equal(r.cls, "primary");
  assert.equal(r.name, "Market St");
  assert.equal(r.minZoom, 7);
  assert.equal(classify({ highway: "motorway" }, false).minZoom, 4);
  assert.equal(classify({ highway: "footway" }, false).minZoom, 15);
  assert.equal(classify({ highway: "construction" }, false), null);
  assert.equal(classify({}, false), null);
});

// ---- mercator and tile ranges ----

test("mercator: origin is the centre, longitude and latitude edges", () => {
  const [x, y] = mercator(0, 0);
  assert.ok(Math.abs(x - 0.5) < 1e-12 && Math.abs(y - 0.5) < 1e-12);
  assert.ok(Math.abs(mercator(-180, 0)[0]) < 1e-12);
  assert.ok(mercator(0, 80)[1] < 0.5, "north is up, so smaller y");
  // Clamped near the poles, so it stays finite.
  assert.ok(Number.isFinite(mercator(0, 90)[1]));
});
test("tileRange: a point lands in the expected tile", () => {
  // Central London (-0.1278, 51.5074) is tile x=8186, y=5448 at zoom 14 (standard slippy map formula).
  const [mx, my] = mercator(-0.1278, 51.5074);
  const r = tileRange(mx, my, mx, my, 14);
  assert.equal(r.x0, 8186);
  assert.equal(r.y0, 5448);
  assert.equal(r.x0, r.x1);
  assert.equal(r.y0, r.y1);
});

// ---- clipping ----

test("clipPolygon: a square inside the tile is unchanged", () => {
  const sq = [[100, 100], [900, 100], [900, 900], [100, 900]];
  assert.deepEqual(clipPolygon(sq), sq);
});
test("clipPolygon: a square outside the tile gives nothing", () => {
  assert.deepEqual(clipPolygon([[-500, 100], [-400, 100], [-400, 200], [-500, 200]]), []);
});
test("clipPolygon: a square over the edge is cut to the tile plus buffer", () => {
  const out = clipPolygon([[-1000, 100], [1000, 100], [1000, 900], [-1000, 900]]);
  const xs = out.map((p) => p[0]);
  assert.ok(Math.min(...xs) >= -64 - 1e-9 && Math.max(...xs) <= 1000 + 1e-9, "x within the box");
  assert.ok(Math.max(...xs) <= EXTENT + 64 + 1e-9);
});
test("clipLine: a line through the tile stays one piece; a line leaving and re-entering makes two", () => {
  assert.equal(clipLine([[0, 0], [4000, 0]]).length, 1);
  const pieces = clipLine([[0, 100], [4000, 100], [4000, 2000], [1000, 2000], [1000, 200]]);
  assert.ok(pieces.length >= 1);
  assert.deepEqual(clipLine([[-500, -500], [-400, -500]]), []);
});

// ---- tile content and size rules ----

test("tileContent: features are clipped and grouped by layer", () => {
  const f = [
    { layer: "road", cls: "primary", name: "A", polygon: false, minZoom: 7, minPx: 0, pts: [[0.2, 0.5], [0.8, 0.5]] },
    { layer: "landuse", cls: "wood", polygon: true, minZoom: 9, minPx: 0, pts: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]] },
  ];
  const c = tileContent(f, 0, 0, 0);
  assert.ok(c.road && c.road[0].tags.name === "A");
  assert.equal(c.road[0].type, 2);
  assert.equal(c.landuse[0].type, 3);
});
test("tooSmall: tiny areas are dropped at low zoom, kept when big enough", () => {
  const tiny = { polygon: true, minPx: 2, pts: [[0.5, 0.5], [0.5001, 0.5], [0.5001, 0.5001]] };
  assert.equal(tooSmall(tiny, 4), true);
  assert.equal(tooSmall(tiny, 18), false);
  assert.equal(tooSmall({ polygon: false, minPx: 2, pts: tiny.pts }, 4), false, "lines are not size-filtered");
});

// ---- tiles and container ----

const SAMPLE = [
  { layer: "road", cls: "primary", name: "Market St", polygon: false, minZoom: 7, minPx: 0, pts: [[0.5, 0.5], [0.5 + 0.01, 0.5 + 0.004]] },
  { layer: "building", cls: "yes", polygon: true, minZoom: 13, minPx: 0, pts: [[0.5, 0.5], [0.5002, 0.5], [0.5002, 0.5002], [0.5, 0.5002]] },
];

test("buildTiles: features appear only from their minimum zoom", () => {
  const tiles = buildTiles(SAMPLE, 0, 14);
  const has = (z, layer) => tiles.some((t) => t.z === z && t.layers.includes(layer));
  assert.ok(!has(6, "road"), "primary road not before zoom 7");
  assert.ok(has(7, "road"));
  assert.ok(!has(12, "building"), "buildings not before zoom 13");
  assert.ok(has(13, "building"));
});
test("container: write, read the index, and decode a tile back", () => {
  const tiles = buildTiles(SAMPLE, 0, 14);
  const buf = packContainer(tiles, { name: "test", bounds: [-2.2, 53.3, -2.0, 53.5], minzoom: 0, maxzoom: 14 });
  const c = readContainer(buf);
  assert.equal(c.index.format, "dmtile");
  assert.equal(c.index.tiles.length, tiles.length);
  assert.equal(c.index.attribution, "© OpenStreetMap contributors (ODbL)");
  const t7 = tiles.find((t) => t.z === 7 && t.layers.includes("road"));
  const mvt = c.tile(7, t7.x, t7.y);
  const road = decodeTile(mvt).find((l) => l.name === "road");
  assert.equal(road.features[0].tags.class, "primary");
  assert.equal(road.features[0].tags.name, "Market St");
  assert.equal(c.tile(7, 0, 0), null, "missing tile is null");
});
test("container: rejects a file that is not .dmtile", () => {
  assert.throws(() => readContainer(Buffer.from("not a tile container at all")), /not a .dmtile/);
});

// ---- end to end from a small .osm.pbf ----

const varint = (n) => {
  const bytes = [];
  while (n >= 128) { bytes.push((n % 128) | 128); n = Math.floor(n / 128); }
  bytes.push(n);
  return Buffer.from(bytes);
};
const zig = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);
const tag = (f, w) => varint(f * 8 + w);
const lenField = (f, buf) => Buffer.concat([tag(f, 2), varint(buf.length), buf]);
const varField = (f, n) => Buffer.concat([tag(f, 0), varint(n)]);
const packedField = (f, nums) => lenField(f, Buffer.concat(nums.map(varint)));
const deltaZigzag = (nums) => { let prev = 0; return nums.map((n) => { const d = n - prev; prev = n; return zig(d); }); };
function strings() {
  const list = [""];
  return {
    id(s) { let i = list.indexOf(s); if (i < 0) { i = list.length; list.push(s); } return i; },
    encode: () => lenField(1, Buffer.concat(list.map((s) => lenField(1, Buffer.from(s, "utf8"))))),
  };
}
const block = (st, groups) => Buffer.concat([st.encode(), ...groups.map((g) => lenField(2, g))]);
function frame(type, data) {
  const blob = Buffer.concat([varField(2, data.length), lenField(3, deflateSync(data))]);
  const header = Buffer.concat([lenField(1, Buffer.from(type)), varField(3, blob.length)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([len, header, blob]);
}

// Coordinates around Stockport in 1e-7 degrees. Node 9 is outside the file on purpose (see the way that uses it).
const NODES = [
  { id: 1, lat: 534000000, lon: -21600000 },
  { id: 2, lat: 534000000, lon: -21500000 },
  { id: 3, lat: 534010000, lon: -21500000 },
  { id: 4, lat: 534010000, lon: -21600000 },
  { id: 5, lat: 534005000, lon: -21550000 },
];

function nodeBlock() {
  const st = strings();
  const dense = Buffer.concat([
    packedField(1, deltaZigzag(NODES.map((n) => n.id))),
    packedField(8, deltaZigzag(NODES.map((n) => n.lat))),
    packedField(9, deltaZigzag(NODES.map((n) => n.lon))),
    packedField(10, NODES.flatMap(() => [0])),
  ]);
  return block(st, [lenField(2, dense)]);
}

function wayBlock() {
  const st = strings();
  const way = (id, refs, tags) => Buffer.concat([
    varField(1, id),
    packedField(2, tags.map(([k]) => st.id(k))),
    packedField(3, tags.map(([, v]) => st.id(v))),
    packedField(8, deltaZigzag(refs)),
  ]);
  const ways = [
    way(100, [1, 2, 3, 4, 1], [["building", "house"]]),           // closed building, kept
    way(101, [1, 2, 5], [["highway", "primary"], ["name", "Market St"]]), // open primary road, kept
    way(102, [1, 2, 3, 4, 1], [["natural", "water"]]),              // closed lake, kept
    way(103, [1, 2, 99], [["highway", "primary"]]),                 // node 99 is not in the file: dropped
    way(104, [1, 5], [["highway", "construction"]]),                // not a drawn class: ignored
    way(105, [2, 3], [["highway", "footway"]]),                     // footpath: kept but only from zoom 15
  ];
  return block(st, [Buffer.concat(ways.map((w) => lenField(3, w)))]);
}

test("end to end: a small .osm.pbf becomes a container with the right layers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "build-tiles-"));
  const pbf = join(dir, "small.osm.pbf");
  const file = Buffer.concat([
    frame("OSMHeader", lenField(4, Buffer.from("OsmSchema-V0.6"))),
    frame("OSMData", nodeBlock()),
    frame("OSMData", wayBlock()),
  ]);
  writeFileSync(pbf, file);

  const bbox = [-2.2, 53.39, -2.1, 53.41];
  const { buffer, stats } = await buildRegion({ pbfPath: pbf, name: "small", bbox, minZoom: 0, maxZoom: 16 });

  assert.equal(stats.waysSeen, 6, "every way was read");
  assert.equal(stats.waysMissingNodes, 1, "the way with node 99 is dropped and counted");
  assert.equal(stats.byLayer.building, 1);
  assert.equal(stats.byLayer.water, 1);
  assert.equal(stats.byLayer.road, 2);

  const c = readContainer(buffer);
  assert.deepEqual(c.index.layers, ["building", "road", "water"]);
  assert.equal(c.index.minzoom, 0);
  assert.equal(c.index.maxzoom, 16);
  // The primary road is in a tile at zoom 7, with its name.
  const any = c.index.tiles.find(([z]) => z === 7);
  assert.ok(any, "a zoom 7 tile exists");
  const layers = decodeTile(c.tile(any[0], any[1], any[2]));
  const road = layers.find((l) => l.name === "road");
  assert.ok(road, "road layer present");
  assert.ok(road.features.some((f) => f.tags.class === "primary" && f.tags.name === "Market St"));
  // The footpath does not appear before zoom 15.
  const z14 = c.index.tiles.filter(([z]) => z === 14).map(([z, x, y]) => decodeTile(c.tile(z, x, y)));
  const footAt14 = z14.flat().flatMap((l) => (l.name === "road" ? l.features : [])).some((f) => f.tags.class === "footway");
  assert.equal(footAt14, false, "footway is not drawn at zoom 14");
});
