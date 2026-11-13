// Builds one DMAP file per grid square for a bounding box, into data/published/squares/.
// Usage: node tools/build-squares.mjs --bbox=minLon,minLat,maxLon,maxLat --zoom=14
// Each file is named lat<i>_lon<j>.dmap. The index lists every square with its size.
// The square files are published to the GitHub release, not committed to git.

import { readFile, copyFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTiles } from "./fetch-tiles.mjs";
import { buildArea } from "./build-area.mjs";
import { squaresTouching, squareBbox, squareId } from "./grid.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SQUARES_DIR = join(ROOT, "data", "published", "squares");
const BUILDER_VERSION = "graph-repair-2";

// Builds every square touching a bounding box given in lon-first order (as build-area uses).
export async function buildSquares({ bbox, zoom, log = console.log }) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  await mkdir(SQUARES_DIR, { recursive: true });
  const indexFile = join(SQUARES_DIR, "index.json");
  let index = {};
  try {
    index = JSON.parse(await readFile(indexFile, "utf8"));
  } catch {
    index = {};
  }

  const squares = squaresTouching([minLat, minLon, maxLat, maxLon]);
  let version = null;
  let built = 0;
  for (const sq of squares) {
    const id = squareId(sq);
    const [sMinLat, sMinLon, sMaxLat, sMaxLon] = squareBbox(sq);
    const sqBbox = [sMinLon, sMinLat, sMaxLon, sMaxLat];
    const fetched = await fetchTiles(sqBbox, zoom, { log: () => {} });
    version = fetched.version;
    const out = join(SQUARES_DIR, `${id}.dmap`);
    const exists = await stat(out).then(() => true, () => false);
    if (index[id] && index[id].version === version && index[id].builder === BUILDER_VERSION && exists) continue;
    await buildArea({ name: id, bbox: sqBbox, zoom, version, log: () => {} });
    await copyFile(join(ROOT, "data", "out", `${id}.dmap`), out);
    index[id] = { version, builder: BUILDER_VERSION, zoom, bbox: sqBbox, bytes: (await stat(out)).size, builtAt: new Date().toISOString() };
    built++;
  }
  await writeFile(indexFile, JSON.stringify(index, null, 2) + "\n");
  log(`squares: ${squares.length} in area, ${built} built, version ${version}`);
  return { total: squares.length, built, version };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n, def) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : def;
  };
  await buildSquares({
    bbox: arg("bbox", "-2.25,53.34,-2.07,53.46").split(",").map(Number),
    zoom: Number(arg("zoom", "14")),
  });
}
