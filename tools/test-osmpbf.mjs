// Tests our OSM PBF reader against known sample files and their expected contents.
// Usage: node tools/test-osmpbf.mjs <fixtures folder>
// The folder must hold somes.pbf, somes.json, test.pbf and manyNodes.pbf (public OSM samples).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPbfBuffer, readPbfFile } from "./osmpbf.mjs";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node tools/test-osmpbf.mjs <fixtures folder>");
  process.exit(2);
}
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const close = (a, b) => Math.abs(a - b) < 1e-7;

function readAll(path) {
  const out = [];
  const push = (e) => out.push(e);
  readPbfFile(path, { node: push, way: push, relation: push });
  return out;
}

// 1. somes.pbf must decode to exactly the 1,577 elements in somes.json, in order.
{
  const got = readAll(join(dir, "somes.pbf"));
  const expected = JSON.parse(readFileSync(join(dir, "somes.json"), "utf8"));
  check(got.length === expected.length, `somes: ${got.length} elements, expected ${expected.length}`);
  let mismatches = 0;
  for (let i = 0; i < Math.min(got.length, expected.length); i++) {
    const g = got[i];
    const e = expected[i];
    let ok = g.type === e.type && g.id === e.id && JSON.stringify(g.tags) === JSON.stringify(e.tags);
    if (e.type === "node") ok = ok && close(g.lat, e.lat) && close(g.lon, e.lon);
    if (e.type === "way") ok = ok && JSON.stringify(g.nodes) === JSON.stringify(e.nodes);
    if (e.type === "relation") ok = ok && JSON.stringify(g.members) === JSON.stringify(e.members);
    if (!ok) {
      mismatches++;
      if (mismatches <= 3) failures.push(`somes: element ${i} differs: got ${JSON.stringify(g).slice(0, 160)}`);
    }
  }
  check(mismatches === 0, `somes: ${mismatches} elements differ`);
  console.log(`somes.pbf: ${got.length} elements checked`);
}

// 2. test.pbf: known values in central London.
{
  const all = readAll(join(dir, "test.pbf"));
  const nodes = all.filter((e) => e.type === "node");
  const ways = all.filter((e) => e.type === "way");
  const rels = all.filter((e) => e.type === "relation");
  check(nodes[0].id === 319408586, "test: first node id");
  check(close(nodes[0].lat, 51.5074089) && close(nodes[0].lon, -0.1080108), "test: first node position");
  check(nodes[2].tags.amenity === "cafe", "test: third node is a cafe");
  check(close(nodes[nodes.length - 1].lat, 51.507406) && close(nodes[nodes.length - 1].lon, -0.1083348), "test: last node position");
  check(ways[0].id === 27776903, "test: first way id");
  check(ways[0].tags.highway === "service", "test: first way is a service road");
  check(ways[0].tags.name === "üßé€", "test: first way name with non-ASCII characters");
  check(ways[0].nodes[0] === 304994979 && ways[0].nodes[1] === 319408587, "test: first way node refs");
  check(rels.length === 1 && rels[0].id === 56688, "test: one relation, id 56688");
  console.log(`test.pbf: ${nodes.length} nodes, ${ways.length} ways, ${rels.length} relations`);
}

// 3. manyNodes.pbf: 3,000 nodes. Also checks the in-memory reader gives the same count.
{
  let count = 0;
  readPbfFile(join(dir, "manyNodes.pbf"), { node: () => count++ });
  check(count === 3000, `manyNodes: ${count} nodes, expected 3000`);
  let memCount = 0;
  readPbfBuffer(readFileSync(join(dir, "manyNodes.pbf")), { node: () => memCount++ });
  check(memCount === 3000, `manyNodes in memory: ${memCount} nodes, expected 3000`);
  console.log(`manyNodes.pbf: ${count} nodes`);
}

if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("all OSM PBF reader checks passed");
