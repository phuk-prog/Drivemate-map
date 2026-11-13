// Offline tests for tools/validate-dmap.mjs. Usage: node tools/test-validate-dmap.mjs
import assert from "node:assert/strict";
import { validateDmap, laneTextProblem } from "./validate-dmap.mjs";
import { writeDmap, readDmap } from "./dmap.mjs";

// Three nodes in a line (A-B-C), 1e-3 degrees apart. Edge 0 A->B one-way, edge 1 B->C two-way, edge 2 C->B two-way.
const U = 10000;
function base() {
  const nodes = [{ lat: 0, lon: 0 }, { lat: 0, lon: U }, { lat: 0, lon: 2 * U }];
  const edges = [
    { from: 0, to: 1, roadClass: 6, flags: 1, points: [[0, 0], [0, U]] },
    { from: 1, to: 2, roadClass: 6, flags: 0, points: [[0, U], [5, 1.5 * U], [0, 2 * U]] },
    { from: 2, to: 1, roadClass: 3, flags: 0, points: [[0, 2 * U], [0, U]] },
  ];
  return {
    bbox: [-U, -U, U, 3 * U],
    nodes,
    edges,
    lines: [{ kind: 1, level: 0, points: [[0, 0], [0, U]] }],
    polygons: [{ kind: 1, height: 0, minHeight: 0, colour: 0, rings: [[[0, 0], [U, 0], [U, U], [0, 0]]] }],
    labels: [{ kind: 1, category: 1, lat: 0, lon: 0, name: "A" }],
    restrictions: [{ kind: 1, from: 0, to: 1, via: 1 }],
    lanes: [{ edge: 1, text: "left|through;right|right" }],
    warnings: [{ kind: 1, lat: 0, lon: U }],
    futureField: 42,
  };
}

let passed = 0;
function ok(name, map) {
  assert.deepEqual(validateDmap(map), [], name);
  passed++;
}
function bad(name, mutate, expectText) {
  const map = base();
  mutate(map);
  const problems = validateDmap(map);
  assert.ok(problems.length > 0, `${name}: expected a problem`);
  assert.ok(problems.some((p) => p.includes(expectText)), `${name}: expected "${expectText}" in ${JSON.stringify(problems)}`);
  passed++;
}

ok("valid file", base());
ok("valid file survives a write/read round trip", readDmap(writeDmap(base())));
ok("speed limits valid", { ...base(), speedLimits: [{ edge: 0, value: 30, unit: 1 }, { edge: 1, value: 50, unit: 0 }] });
ok("two-way edges allow either end", { ...base(), restrictions: [{ kind: 2, from: 1, to: 2, via: 1 }] });

bad("bad from node", (m) => (m.edges[0].from = 99), "edge node id");
bad("bad to node", (m) => (m.edges[1].to = 3), "edge node id");
bad("edge start far from node", (m) => (m.edges[0].points[0] = [0, 500]), "edge start far");
bad("edge end far from node", (m) => (m.edges[1].points[2] = [300, 2 * U]), "edge end far");
bad("edge with one point", (m) => (m.edges[1].points = [[0, U]]), "edge points");
bad("road class 0", (m) => (m.edges[0].roadClass = 0), "road class");
bad("road class 9", (m) => (m.edges[0].roadClass = 9), "road class");
bad("restriction bad kind", (m) => (m.restrictions[0].kind = 3), "restriction kind");
bad("restriction bad edge", (m) => (m.restrictions[0].to = 7), "restriction edge id");
bad("restriction bad via", (m) => (m.restrictions[0].via = 9), "restriction via node");
bad("restriction from equals to", (m) => (m.restrictions[0] = { kind: 1, from: 1, to: 1, via: 1 }), "from equals to");
bad("restriction non-adjacent (via not on from)", (m) => (m.restrictions[0].via = 2), "does not end at via");
bad("restriction from one-way starts at via", (m) => (m.restrictions[0] = { kind: 1, from: 0, to: 1, via: 0 }), "does not end at via");
bad("restriction to-edge not at via", (m) => (m.restrictions[0] = { kind: 1, from: 1, to: 0, via: 1 }), "does not start at via");
bad("duplicate restriction", (m) => m.restrictions.push({ ...m.restrictions[0] }), "duplicate restriction");
bad("lane bad edge", (m) => (m.lanes[0].edge = 50), "lane edge id");
bad("lane duplicate edge", (m) => m.lanes.push({ edge: 1, text: "through" }), "duplicate lane");
bad("lane garbage", (m) => (m.lanes[0].text = "left|banana"), "lane text");
bad("lane double semicolon", (m) => (m.lanes[0].text = "left;;right"), "lane text");
bad("lane uppercase", (m) => (m.lanes[0].text = "Left|Through"), "lane text");
bad("lane empty text", (m) => (m.lanes[0].text = ""), "lane text");
bad("too many lanes", (m) => (m.lanes[0].text = Array(13).fill("through").join("|")), "lane text");
bad("warning kind 0", (m) => (m.warnings[0].kind = 0), "warning kind");
bad("warning kind 4", (m) => (m.warnings[0].kind = 4), "warning kind");
bad("warning outside bbox", (m) => (m.warnings[0] = { kind: 2, lat: 20 * U, lon: 0 }), "warning outside bbox");
bad("empty label", (m) => (m.labels[0].name = ""), "label name");
bad("ring too short", (m) => (m.polygons[0].rings[0] = [[0, 0], [1, 1]]), "polygon ring");
bad("polygon with no rings", (m) => (m.polygons[0].rings = []), "polygon rings");
bad("line with one point", (m) => (m.lines[0].points = [[0, 0]]), "line points");
bad("bbox inverted", (m) => (m.bbox = [U, U, -U, -U]), "bbox");
bad("bbox out of range", (m) => (m.bbox = [-U, -U, 950000000, U]), "bbox");
bad("speed limit bad edge", (m) => (m.speedLimits = [{ edge: 9, value: 30, unit: 1 }]), "speed limit edge");
bad("speed limit duplicate", (m) => (m.speedLimits = [{ edge: 1, value: 30, unit: 1 }, { edge: 1, value: 40, unit: 1 }]), "duplicate speed limit");
bad("speed limit unit", (m) => (m.speedLimits = [{ edge: 1, value: 30, unit: 2 }]), "speed limit unit");
bad("speed limit too low", (m) => (m.speedLimits = [{ edge: 1, value: 4, unit: 0 }]), "speed limit value");
bad("speed limit too high", (m) => (m.speedLimits = [{ edge: 1, value: 131, unit: 0 }]), "speed limit value");

assert.equal(laneTextProblem("none|through;slight_right|merge_to_left|reversible"), null);
assert.equal(laneTextProblem("|through"), null);
assert.ok(laneTextProblem("left|"+"x"));
passed += 3;

// A large number of problems is summarised, not listed in full.
{
  const m = base();
  for (let i = 0; i < 1000; i++) m.lanes.push({ edge: 1, text: "through" });
  const problems = validateDmap(m);
  assert.ok(problems.length < 5 && problems[0].includes("1000"), "problems are summarised");
  passed++;
}

console.log(`all ${passed} validate-dmap tests passed`);
