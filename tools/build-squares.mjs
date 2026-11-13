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
import { fetchTiles, sourceVersion } from "./fetch-tiles.mjs";
import { buildArea } from "./build-area.mjs";
import { squaresTouching, squareBbox, squareId } from "./grid.mjs";
import { geofabrikPolyUrl, prepareSplitOsm } from "./osm-prepare.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SQUARES_DIR = join(ROOT, "data", "published", "squares");
const BUILDER_VERSION = "graph-repair-5";

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
// uploads: each file built is added as [release tag, path] (maps-latest for these fixed areas).
export async function buildSquares({ bbox, zoom, osm, beforeBuild, maxBuild = Infinity, uploads = [], log = console.log }) {
  const builder = osm ? `${BUILDER_VERSION}+osm1` : BUILDER_VERSION;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  await mkdir(SQUARES_DIR, { recursive: true });
  const index = await readSquaresIndex();
  // The map source version is read once, before any tile is fetched, so a square that is up to date costs no download.
  const { version } = await sourceVersion();

  const squares = squaresTouching([minLat, minLon, maxLat, maxLon]);
  let built = 0;
  let waiting = 0;
  let prepared = false;
  for (const sq of squares) {
    const id = squareId(sq);
    const [sMinLat, sMinLon, sMaxLat, sMaxLon] = squareBbox(sq);
    const sqBbox = [sMinLon, sMinLat, sMaxLon, sMaxLat];
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
    if (beforeBuild && !prepared) {
      prepared = true;
      await beforeBuild();
    }
    // The tiles' own version is the one built and recorded, in case the source changed during the run.
    const fetched = await fetchTiles(sqBbox, zoom, { log: () => {} });
    await buildArea({ name: id, bbox: sqBbox, zoom, version: fetched.version, osmName: osm || id, log: () => {} });
    await copyFile(join(ROOT, "data", "out", `${id}.dmap`), out);
    index[id] = indexEntry({ version: fetched.version, builder, zoom, bbox: sqBbox, file: out });
    uploads.push(["maps-latest", out]);
    built++;
  }
  await writeSquaresIndex(index);
  log(`squares: ${squares.length} in area, ${built} built, ${waiting} waiting for a later run, version ${version}`);
  return { total: squares.length, built, waiting, version };
}

async function readSquaresIndex() {
  try {
    return JSON.parse(await readFile(join(SQUARES_DIR, "index.json"), "utf8"));
  } catch {
    return {};
  }
}

async function writeSquaresIndex(index) {
  await writeFile(join(SQUARES_DIR, "index.json"), JSON.stringify(index, null, 2) + "\n");
}

// ---- Growing outwards ----------------------------------------------------------------------------------------
// regions.json "grow" makes the map grow by itself: each scheduled run publishes the squares nearest to a starting
// point ("from", [lat, lon]) that are not published yet, inside the boundary of a Geofabrik extract ("osm"), whose
// turn restrictions, lanes, warnings and speed limits they get. "after" records the last square a run reached, so
// the next run carries on from there. Squares with no roads (water, open moor) are passed over and not published.
// Squares already published are rebuilt when the map source or the builder changes, with at most half of a run's
// squares, so the growth never stalls. Each 1° block of squares has its own release (at most 400 squares), so no
// release grows without limit.

// Reads an Osmosis .poly boundary, as Geofabrik publishes for each extract: a name line, then rings of "lon lat"
// lines, each ending with END, and a last END. A ring whose name starts with "!" is a hole.
// Returns { rings: [{ hole, points: [[lat, lon], ...] }], bbox: [minLon, minLat, maxLon, maxLat] } in degrees.
export function parsePoly(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const rings = [];
  let ring = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    if (line === "END") {
      if (!ring) break; // the last END closes the file
      rings.push(ring);
      ring = null;
    } else if (!ring) {
      ring = { hole: line.startsWith("!"), points: [] };
    } else {
      const [lon, lat] = line.split(/\s+/).map(Number);
      ring.points.push([lat, lon]);
    }
  }
  let bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) {
    if (r.hole) continue;
    for (const [lat, lon] of r.points) bbox = [Math.min(bbox[0], lon), Math.min(bbox[1], lat), Math.max(bbox[2], lon), Math.max(bbox[3], lat)];
  }
  return { rings, bbox };
}

// Ray casting: true when the point is inside the ring.
function inRing(points, lat, lon) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ai, oi] = points[i];
    const [aj, oj] = points[j];
    if (ai > lat !== aj > lat && lon < ((oj - oi) * (lat - ai)) / (aj - ai) + oi) inside = !inside;
  }
  return inside;
}

// True when the point (degrees) is inside one of the boundary's rings and not inside one of its holes.
export function insidePoly(poly, lat, lon) {
  return poly.rings.some((r) => !r.hole && inRing(r.points, lat, lon)) && !poly.rings.some((r) => r.hole && inRing(r.points, lat, lon));
}

// Distance on the ground in km between two [lat, lon] points in degrees.
function distanceKm([lat1, lon1], [lat2, lon2]) {
  const r = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const centreOf = (sq) => {
  const [a, b, c, d] = squareBbox(sq);
  return [(a + c) / 2, (b + d) / 2];
};

// Distance from `from` to a square's centre, rounded to the metre. Squares that are mirror images about the start
// would otherwise differ in the last digits by rounding error, which another Node version could compute the other
// way round, and a run could then skip a square for good.
const kmTo = (from, sq) => Math.round(distanceKm(from, centreOf(sq)) * 1000) / 1000;

// Squares whose centre is inside the boundary, nearest to `from` first. Squares at the same distance are ordered
// by id, so every run sees the same order. Each item is { sq, id, km }.
export function growthOrder(poly, from) {
  const [minLon, minLat, maxLon, maxLat] = poly.bbox;
  const out = [];
  for (const sq of squaresTouching([minLat, minLon, maxLat, maxLon])) {
    const c = centreOf(sq);
    if (insidePoly(poly, c[0], c[1])) out.push({ sq, id: squareId(sq), km: kmTo(from, sq) });
  }
  out.sort((x, y) => x.km - y.km || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return out;
}

// Position in the order just past the square `after`. Found by distance, then id, so a run carries on from the
// right place even if the order changed a little (a new boundary). No `after` starts at the beginning.
export function resumeAt(order, after, from) {
  const m = after ? /^lat(-?\d+)_lon(-?\d+)$/.exec(after) : null;
  if (!m) return 0;
  const km = kmTo(from, { latIdx: Number(m[1]), lonIdx: Number(m[2]) });
  let i = 0;
  while (i < order.length && (order[i].km < km || (order[i].km === km && order[i].id <= after))) i++;
  return i;
}

// The release a growing square is published in: one per 1° block, for example squares-lat53_lon-3.
export function squareRelease({ latIdx, lonIdx }) {
  return `squares-lat${Math.floor(latIdx / 20)}_lon${Math.floor(lonIdx / 20)}`;
}

const releaseUrl = (tag, id) => `https://github.com/${process.env.GITHUB_REPOSITORY ?? "phuk-prog/Drivemate-map"}/releases/download/${tag}/${id}.dmap`;

// One run of growing outwards. grow is regions.json "grow"; maxBuild is the number of squares this run may build,
// and maxCheck the number of new squares it may look at (squares with no roads cost a download and a build too).
// Returns { after, built, refreshed, roadless, left }: the new "after", and how many squares are still to reach.
export async function growSquares({ grow, maxBuild, maxCheck = 400, uploads = [], log = console.log }) {
  const builder = `${BUILDER_VERSION}+osm1`;
  const name = grow.osm.geofabrik;
  const polyUrl = geofabrikPolyUrl(name);
  const res = await fetch(polyUrl);
  if (!res.ok) throw new Error(`boundary ${polyUrl}: HTTP ${res.status}`);
  const poly = parsePoly(await res.text());
  const order = growthOrder(poly, grow.from);
  const { version } = await sourceVersion();
  await mkdir(SQUARES_DIR, { recursive: true });
  const index = await readSquaresIndex();
  const upToDate = (e) => e && e.version === version && e.builder === builder;

  let osmReady = false;
  // Builds one square. Returns false (and publishes nothing) when it has no roads.
  const buildOne = async ({ sq, id }) => {
    if (!osmReady) {
      await prepareSplitOsm({ geofabrik: name, name, bbox: poly.bbox, log });
      osmReady = true;
    }
    const [sMinLat, sMinLon, sMaxLat, sMaxLon] = squareBbox(sq);
    const sqBbox = [sMinLon, sMinLat, sMaxLon, sMaxLat];
    const fetched = await fetchTiles(sqBbox, grow.zoom, { log: () => {} });
    const block = `lat${Math.floor(sq.latIdx / 20)}_lon${Math.floor(sq.lonIdx / 20)}`;
    const { report } = await buildArea({ name: id, bbox: sqBbox, zoom: grow.zoom, version: fetched.version, osmName: `${name}@${block}`, log: () => {} });
    if (report.routableEdges === 0) return false;
    const out = join(SQUARES_DIR, `${id}.dmap`);
    await copyFile(join(ROOT, "data", "out", `${id}.dmap`), out);
    const tag = squareRelease(sq);
    index[id] = { ...indexEntry({ version: fetched.version, builder, zoom: grow.zoom, bbox: sqBbox, file: out }), url: releaseUrl(tag, id) };
    uploads.push([tag, out]);
    return true;
  };

  const start = resumeAt(order, grow.after, grow.from);
  // Refresh first: squares this growth has reached that are out of date, nearest first, with at most half the run.
  let refreshed = 0;
  for (let i = 0; i < start && refreshed < Math.floor(maxBuild / 2); i++) {
    const o = order[i];
    if (!index[o.id] || upToDate(index[o.id])) continue;
    if (await buildOne(o)) refreshed++;
    else delete index[o.id]; // it has no roads any more
  }
  // Then grow: carry on outwards from where the last run stopped.
  let after = grow.after ?? null;
  let built = 0;
  let checked = 0;
  let roadless = 0;
  let i = start;
  for (; i < order.length && refreshed + built < maxBuild && checked < maxCheck; i++) {
    const o = order[i];
    if (!upToDate(index[o.id])) {
      checked++;
      if (await buildOne(o)) built++;
      else roadless++;
    }
    after = o.id;
  }
  await writeSquaresIndex(index);
  const left = order.length - i;
  const reach = i > 0 ? order[i - 1].km.toFixed(1) : "0";
  log(`growing from [${grow.from}] inside ${name}: ${refreshed} refreshed, ${built} added, ${roadless} with no roads passed over; reached ${reach} km; ${left} of ${order.length} squares still to reach`);
  return { after, built, refreshed, roadless, left };
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
