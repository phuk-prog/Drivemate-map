// Builds one DMAP file per grid square for a bounding box, into data/published/squares/.
// Usage: node tools/build-squares.mjs --bbox=minLon,minLat,maxLon,maxLat --zoom=14
// Each file is named lat<i>_lon<j>.dmap. The index lists every square with its size.
// The square files are published to the GitHub release, not committed to git. Each entry records
// bytes (the .dmap) and gzBytes (the .dmap.gz the release serves, as gzip -9 makes it).

import { readFile, copyFile, mkdir, writeFile, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTiles } from "./fetch-tiles.mjs";
import { buildArea } from "./build-area.mjs";
import { squaresTouching, squareBbox, squareId } from "./grid.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SQUARES_DIR = join(ROOT, "data", "published", "squares");
const BUILDER_VERSION = "graph-repair-5-roundabouts";

// Compressed size of a square file, made the way the update workflow makes its .dmap.gz:
// "gzip -9 -c <file>". The release uploads that file, so this is the size the app downloads.
export function gzipBytes(file) {
  const r = spawnSync("gzip", ["-9", "-c", file], { maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gzip failed for ${file}: ${r.stderr}`);
  return r.stdout.length;
}

// One index entry for a built square file: its size as built, and its compressed size.
export function indexEntry({ version, builder, zoom, bbox, file }) {
  return { version, builder, zoom, bbox, bytes: statSync(file).size, gzBytes: gzipBytes(file), builtAt: new Date().toISOString() };
}

// Builds every square touching a bounding box given in lon-first order (as build-area uses).
// osm: name of the OSM caches to use for every square (see build-area osmName); builderTag is added to the
// builder version so squares are rebuilt when OSM data is switched on.
// maxBuild: build at most this many squares in this call; the rest wait for a later run (the index is the resume point).
export async function buildSquares({ bbox, zoom, osm, beforeBuild, maxBuild = Infinity, log = console.log }) {
  const builder = osm ? `${BUILDER_VERSION}+osm1` : BUILDER_VERSION;
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
  let waiting = 0;
  let prepared = false;
  for (const sq of squares) {
    const id = squareId(sq);
    const [sMinLat, sMinLon, sMaxLat, sMaxLon] = squareBbox(sq);
    const sqBbox = [sMinLon, sMinLat, sMaxLon, sMaxLat];
    const fetched = await fetchTiles(sqBbox, zoom, { log: () => {} });
    version = fetched.version;
    const out = join(SQUARES_DIR, `${id}.dmap`);
    // On a CI runner the .dmap files are not in the checkout (they live in the release), so the index alone says "built".
    const exists = process.env.TRUST_INDEX === "1" || (await stat(out).then(() => true, () => false));
    if (index[id] && index[id].version === version && index[id].builder === builder && exists) {
      // Entries from before gzBytes was recorded get it now, when the local file is there.
      if (index[id].gzBytes === undefined && (await stat(out).then(() => true, () => false))) index[id].gzBytes = gzipBytes(out);
      continue;
    }
    if (built >= maxBuild) {
      waiting++;
      continue;
    }
    if (beforeBuild && built === 0 && !prepared) {
      prepared = true;
      await beforeBuild();
    }
    await buildArea({ name: id, bbox: sqBbox, zoom, version, osmName: osm || id, log: () => {} });
    await copyFile(join(ROOT, "data", "out", `${id}.dmap`), out);
    index[id] = indexEntry({ version, builder, zoom, bbox: sqBbox, file: out });
    built++;
  }
  await writeFile(indexFile, JSON.stringify(index, null, 2) + "\n");
  log(`squares: ${squares.length} in area, ${built} built, ${waiting} waiting for a later run, version ${version}`);
  return { total: squares.length, built, waiting, version };
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
