// Tests every grid square file: decodes, lies inside its own square, has roads, and is small enough.
// Usage: node tools/test-squares.mjs [--allow-empty]
// --allow-empty: a square with no roads passes (open sea inside a county's boundary).

import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDmap, fromFixed7 } from "./dmap.mjs";
import { squareBbox, squareIndex, squareId } from "./grid.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "published", "squares");
const MAX_BYTES = 100 * 1024 * 1024;
const ALLOW_EMPTY = process.argv.includes("--allow-empty");
const failures = [];
const index = JSON.parse(await readFile(join(DIR, "index.json"), "utf8"));
const files = (await readdir(DIR)).filter((f) => f.endsWith(".dmap"));

for (const file of files) {
  const id = file.replace(/\.dmap$/, "");
  const size = (await stat(join(DIR, file))).size;
  if (size > MAX_BYTES) failures.push(`${id}: over 100 MB`);
  if (!index[id]) failures.push(`${id}: no index entry`);
  let map;
  try {
    map = readDmap(await readFile(join(DIR, file)));
  } catch (err) {
    failures.push(`${id}: does not decode: ${err.message}`);
    continue;
  }
  // The file name must match the square its bounding box belongs to.
  const [minLat, minLon, maxLat, maxLon] = map.bbox.map(fromFixed7);
  const named = squareIndex(minLat + 1e-9, minLon + 1e-9);
  if (squareId(named) !== id) failures.push(`${id}: bounding box belongs to ${squareId(named)}`);
  const [sMinLat, , sMaxLat] = squareBbox(named);
  if (Math.abs(sMinLat - minLat) > 1e-6 || Math.abs(sMaxLat - maxLat) > 1e-6) failures.push(`${id}: bounding box is not a grid square`);
  if (map.edges.length === 0 && !ALLOW_EMPTY) failures.push(`${id}: no roads`);
  console.log(`${id}: ok (${size} bytes, ${map.edges.length} roads)`);
}
if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log(`all ${files.length} square file(s) passed`);
