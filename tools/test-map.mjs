// Tests every published map file before it can be committed.
// Checks the file decodes, the index matches the files, coordinates are valid,
// and the content is in the expected ranges. Exits with code 1 on any failure.
// Usage: node tools/test-map.mjs

import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDmap, fromFixed7 } from "./dmap.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED = join(ROOT, "data", "published");
const MAX_BYTES = 100 * 1024 * 1024; // GitHub rejects files over 100 MB
const failures = [];
const fail = (msg) => failures.push(msg);

const index = JSON.parse(await readFile(join(PUBLISHED, "index.json"), "utf8"));
const files = (await readdir(PUBLISHED)).filter((f) => f.endsWith(".dmap"));

for (const file of files) {
  const id = file.replace(/\.dmap$/, "");
  const path = join(PUBLISHED, file);
  const size = (await stat(path)).size;
  if (size > MAX_BYTES) fail(`${id}: ${size} bytes is over the 100 MB limit`);
  if (!index[id]) fail(`${id}: file has no index entry`);

  let map;
  try {
    map = readDmap(await readFile(path));
  } catch (err) {
    fail(`${id}: does not decode: ${err.message}`);
    continue;
  }

  const [minLat, minLon, maxLat, maxLon] = map.bbox.map(fromFixed7);
  if (!(minLat < maxLat && minLon < maxLon)) fail(`${id}: bounding box is empty`);
  if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) fail(`${id}: bounding box out of range`);
  if (map.edges.length === 0) fail(`${id}: no routable roads`);
  if (map.polygons.length === 0) fail(`${id}: no areas`);

  const outside = (p) => p[0] < map.bbox[0] - 500000 || p[0] > map.bbox[2] + 500000 || p[1] < map.bbox[1] - 500000 || p[1] > map.bbox[3] + 500000;
  const sample = map.edges.slice(0, 2000);
  if (sample.some((e) => e.points.some(outside))) fail(`${id}: road points lie outside the bounding box`);

  if (map.edges.some((e) => e.roadClass < 1 || e.roadClass > 8)) fail(`${id}: road class out of range`);
  if (map.edges.some((e) => e.from >= map.nodes.length || e.to >= map.nodes.length)) fail(`${id}: edge refers to a missing node`);
  if (map.labels.some((l) => !l.name)) fail(`${id}: label with empty name`);

  console.log(`${id}: ok (${size} bytes, ${map.nodes.length} nodes, ${map.edges.length} roads, ${map.polygons.length} areas, ${map.labels.length} labels)`);
}

for (const id of Object.keys(index)) {
  if (!files.includes(`${id}.dmap`)) fail(`${id}: in index but file is missing`);
}

if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log(`all ${files.length} map file(s) passed`);
