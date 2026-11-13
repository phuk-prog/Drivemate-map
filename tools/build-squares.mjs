// Builds one DMAP file per grid square for a bounding box, into data/published/squares/.
// Usage: node tools/build-squares.mjs --bbox=minLon,minLat,maxLon,maxLat --zoom=14
// Each file is named lat<i>_lon<j>.dmap. The index lists every square with its size, and the
// address it is published at: the GitHub release of its latitude row (see grid.mjs).
// The square files are published to the GitHub releases, not committed to git.

import { readFile, copyFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTiles, sourceVersion } from "./fetch-tiles.mjs";
import { buildArea } from "./build-area.mjs";
import { squaresTouching, squareBbox, squareId, squareRelease, squareUrl, parseSquareId } from "./grid.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// SQUARES_DIR can be set to another folder (the tests use a temporary one).
export const SQUARES_DIR = process.env.SQUARES_DIR || join(ROOT, "data", "published", "squares");
export const BUILDER_VERSION = "osm-v5-1"; // change when the output changes, so squares are rebuilt

export async function readSquaresIndex(dir = SQUARES_DIR) {
  try {
    return JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  } catch {
    return {};
  }
}

// Gives every entry the address of its file, then writes the index.
export async function writeSquaresIndex(index, dir = SQUARES_DIR) {
  for (const [id, entry] of Object.entries(index)) {
    const sq = parseSquareId(id);
    if (!sq) continue;
    entry.release = squareRelease(sq);
    entry.url = squareUrl(sq);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
}

// A square is up to date when it was built from the current tiles by the current builder.
// Its file need not be on this machine: once indexed, it has been published to its release.
export function isUpToDate(entry, version) {
  return Boolean(entry && entry.version === version && entry.builder === BUILDER_VERSION);
}

// Builds the squares touching a bounding box given in lon-first order (as build-area uses), or
// the given list of squares ({ latIdx, lonIdx }). Squares that are up to date are skipped.
// osmRoads: roads for the area, or loadOsmRoads: an async function returning them, called only
// when at least one square must be built (so no extract is downloaded for nothing).
// deadline: a time (ms) after which no new square is started; the result then has complete=false.
// force: rebuild every square, even when up to date.
export async function buildSquares({
  bbox, squares = null, zoom, osmRoads = null, loadOsmRoads = null, deadline = Infinity, force = false, source = null, log = console.log,
}) {
  const index = await readSquaresIndex();
  const list = squares ?? squaresTouching([bbox[1], bbox[0], bbox[3], bbox[2]]);
  const src = source ?? (await sourceVersion());
  const version = src.version;
  const todo = list.filter((sq) => force || !isUpToDate(index[squareId(sq)], version));
  let built = 0;
  let complete = true;
  const builtIds = [];
  if (todo.length > 0 && Date.now() < deadline && !osmRoads && loadOsmRoads) osmRoads = await loadOsmRoads();
  for (const sq of todo) {
    if (Date.now() >= deadline) {
      complete = false;
      break;
    }
    const id = squareId(sq);
    const [sMinLat, sMinLon, sMaxLat, sMaxLon] = squareBbox(sq);
    const sqBbox = [sMinLon, sMinLat, sMaxLon, sMaxLat];
    await fetchTiles(sqBbox, zoom, { log: () => {}, source: src });
    await buildArea({ name: id, bbox: sqBbox, zoom, version, osmRoads, log: () => {} });
    const out = join(SQUARES_DIR, `${id}.dmap`);
    await mkdir(SQUARES_DIR, { recursive: true });
    await copyFile(join(ROOT, "data", "out", `${id}.dmap`), out);
    index[id] = { version, builder: BUILDER_VERSION, zoom, bbox: sqBbox, bytes: (await stat(out)).size, builtAt: new Date().toISOString() };
    built++;
    builtIds.push(id);
    if (built % 25 === 0) {
      await writeSquaresIndex(index);
      log(`squares: ${built}/${todo.length} built`);
    }
  }
  await writeSquaresIndex(index);
  log(`squares: ${list.length} in area, ${list.length - todo.length} up to date, ${built} built${complete ? "" : " (time is up; the rest wait for the next run)"}, version ${version}`);
  return { total: list.length, built, skipped: list.length - todo.length, version, complete, builtIds, index };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n, def) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : def;
  };
  await buildSquares({
    bbox: arg("bbox", "-2.25,53.34,-2.07,53.46").split(",").map(Number),
    zoom: Number(arg("zoom", "14")),
    force: process.argv.includes("--force"),
  });
}
