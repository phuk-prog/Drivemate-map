// Run: node --test tools/test-mvt-encode.mjs
// Round-trip tests: what tools/mvt-encode.mjs writes, tools/mvt.mjs must read back unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeTile } from "./mvt-encode.mjs";
import { decodeTile } from "./mvt.mjs";

test("empty tile encodes and decodes to no layers", () => {
  assert.deepEqual(decodeTile(encodeTile([])), []);
});

test("layer name, extent and feature count survive", () => {
  const buf = encodeTile([{ name: "water", extent: 4096, features: [] }]);
  const layers = decodeTile(buf);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].name, "water");
  assert.equal(layers[0].extent, 4096);
  assert.equal(layers[0].features.length, 0);
});

test("tags of each kind survive, including negative integers and booleans", () => {
  const buf = encodeTile([{
    name: "poi",
    features: [{ type: 1, tags: { name: "Café Ünïcode", class: "shop", rank: 7, offset: -12, oneway: true, bridge: false }, parts: [[[10, 20]]] }],
  }]);
  const f = decodeTile(buf)[0].features[0];
  assert.deepEqual(f.tags, { name: "Café Ünïcode", class: "shop", rank: 7, offset: -12, oneway: true, bridge: false });
});

test("unsupported tag values are skipped, not written", () => {
  const buf = encodeTile([{ name: "x", features: [{ type: 1, tags: { ok: "yes", bad: 1.5, nothing: null }, parts: [[[1, 1]]] }] }]);
  assert.deepEqual(decodeTile(buf)[0].features[0].tags, { ok: "yes" });
});

test("points survive, several points in one part", () => {
  const pts = [[100, 200], [101, 205], [4000, 10]];
  const buf = encodeTile([{ name: "p", features: [{ type: 1, tags: {}, parts: [pts] }] }]);
  const f = decodeTile(buf)[0].features[0];
  assert.equal(f.type, 1);
  assert.deepEqual(f.parts.flat(), pts);
});

test("a line survives with every vertex in order", () => {
  const line = [[0, 0], [50, 0], [50, 80], [10, 90]];
  const buf = encodeTile([{ name: "road", features: [{ type: 2, tags: { class: "primary" }, parts: [line] }] }]);
  const f = decodeTile(buf)[0].features[0];
  assert.equal(f.type, 2);
  assert.deepEqual(f.parts[0], line);
});

test("a polygon survives as a closed ring", () => {
  const ring = [[0, 0], [4096, 0], [4096, 4096], [0, 4096]];
  const buf = encodeTile([{ name: "landuse", features: [{ type: 3, tags: { class: "wood" }, parts: [ring] }] }]);
  const f = decodeTile(buf)[0].features[0];
  assert.equal(f.type, 3);
  const got = f.parts[0];
  // The decoder may repeat the first point at the end; compare the vertices without it.
  const trimmed = got.length > 1 && got[0][0] === got[got.length - 1][0] && got[0][1] === got[got.length - 1][1] ? got.slice(0, -1) : got;
  assert.deepEqual(trimmed, ring);
});

test("a polygon with a repeated closing point is written once", () => {
  const ring = [[0, 0], [100, 0], [100, 100], [0, 0]];
  const buf = encodeTile([{ name: "a", features: [{ type: 3, tags: {}, parts: [ring] }] }]);
  const f = decodeTile(buf)[0].features[0];
  const got = f.parts[0];
  const trimmed = got.length > 1 && got[0][0] === got[got.length - 1][0] && got[0][1] === got[got.length - 1][1] ? got.slice(0, -1) : got;
  assert.deepEqual(trimmed, [[0, 0], [100, 0], [100, 100]]);
});

test("degenerate parts are dropped, valid ones kept", () => {
  const buf = encodeTile([{
    name: "d",
    features: [
      { type: 2, tags: {}, parts: [[[1, 1]]] },          // one point is not a line
      { type: 3, tags: {}, parts: [[[0, 0], [1, 1]]] },  // two points is not a polygon
    ],
  }]);
  const [a, b] = decodeTile(buf)[0].features;
  assert.equal(a.parts.length, 0);
  assert.equal(b.parts.length, 0);
});

test("several layers and many features in one tile", () => {
  const features = [];
  for (let i = 0; i < 500; i++) features.push({ type: 2, tags: { i: i % 7, class: i % 2 ? "a" : "b" }, parts: [[[i, i], [i + 3, i + 9]]] });
  const layers = decodeTile(encodeTile([{ name: "one", features }, { name: "two", features: [] }]));
  assert.deepEqual(layers.map((l) => l.name), ["one", "two"]);
  assert.equal(layers[0].features.length, 500);
  assert.deepEqual(layers[0].features[123].parts[0], [[123, 123], [126, 132]]);
  assert.equal(layers[0].features[123].tags.i, 123 % 7);
});

test("large coordinates and counts use multi-byte varints", () => {
  const big = [[16000, 16000], [16380, 1], [2, 16380]];
  const buf = encodeTile([{ name: "big", extent: 16384, features: [{ type: 2, tags: { n: 1234567 }, parts: [big] }] }]);
  const layer = decodeTile(buf)[0];
  assert.equal(layer.extent, 16384);
  assert.deepEqual(layer.features[0].parts[0], big);
  assert.equal(layer.features[0].tags.n, 1234567);
});
