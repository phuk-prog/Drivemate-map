// Loads the OSM roads for an area from one or more Geofabrik extracts, and merges them.
// An area near an extract's border needs its neighbours too: Stockport's south-east corner,
// for example, lies in Cheshire and Derbyshire, not Greater Manchester.
// Roads, restrictions and cameras that appear in two extracts are kept once.

import { mkdir, stat, rename, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { extractUrl } from "./geofabrik.mjs";
import { loadOsmRoads } from "./load-osm.mjs";

export function mergeOsmRoads(parts) {
  const ways = new Map();
  const relations = new Map();
  const coords = new Map();
  const cameras = new Map();
  for (const p of parts) {
    for (const w of p.ways) ways.set(w.id, w);
    for (const r of p.relations) relations.set(r.id, r);
    for (const [id, c] of p.coords) coords.set(id, c);
    for (const c of p.cameras ?? []) cameras.set(`${c.lat},${c.lon}`, c);
  }
  return { ways: [...ways.values()], relations: [...relations.values()], coords, cameras: [...cameras.values()] };
}

// Keeps only the roads with a node inside bbox ([minLon, minLat, maxLon, maxLat]), their nodes,
// the restrictions whose via node is one of those nodes, and the cameras inside bbox.
// A square inside bbox gets exactly the roads it would get from the whole extract, and a
// county's roads fit in memory even when several large extracts are merged.
export function clipOsmRoads({ ways, relations, coords, cameras = [] }, bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const inside = (c) => c && c[0] >= minLat && c[0] <= maxLat && c[1] >= minLon && c[1] <= maxLon;
  const keptWays = ways.filter((w) => w.nodes.some((n) => inside(coords.get(n))));
  const keptCoords = new Map();
  for (const w of keptWays) for (const n of w.nodes) if (coords.has(n)) keptCoords.set(n, coords.get(n));
  const keptRelations = relations.filter((r) => r.members.some((m) => m.type === "node" && m.role === "via" && keptCoords.has(m.ref)));
  const keptCameras = cameras.filter((c) => inside([c.lat, c.lon]));
  return { ways: keptWays, relations: keptRelations, coords: keptCoords, cameras: keptCameras };
}

// Makes sure cacheDir holds the current copy of one extract, and returns its path.
// record: { [id]: { lastModified, bytes, url, downloadedAt, usedAt } }, kept by the caller in
// data/published/growth.json. The file is downloaded again only when Geofabrik's Last-Modified
// (asked with HEAD) differs from the copy we have, or we have no copy.
export async function ensureExtract(id, cacheDir, { record = {}, url = null, fetchFn = fetch, log = console.log } = {}) {
  await mkdir(cacheDir, { recursive: true });
  const file = join(cacheDir, `${id}.osm.pbf`);
  const link = url ?? (await extractUrl(id));
  const have = record[id];
  const size = await stat(file).then((s) => s.size, () => -1);
  let remote = null;
  try {
    const head = await fetchFn(link, { method: "HEAD" });
    if (head.ok) remote = head.headers.get("last-modified");
  } catch (err) {
    log(`${id}: HEAD request failed (${err.message})`);
  }
  const current = have && size === have.bytes && (remote === null || remote === have.lastModified);
  if (current) {
    log(`${id}: cached copy is current (Last-Modified ${have.lastModified})`);
  } else {
    log(`${id}: downloading ${link}`);
    const res = await fetchFn(link);
    if (!res.ok) throw new Error(`OSM extract ${id}: HTTP ${res.status}`);
    const part = `${file}.part`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    await rename(part, file);
    record[id] = {
      url: link,
      lastModified: res.headers.get("last-modified") ?? remote,
      bytes: (await stat(file)).size,
      downloadedAt: new Date().toISOString(),
    };
  }
  record[id].usedAt = new Date().toISOString();
  return file;
}

// Deletes cached extracts that no run has used for maxAgeHours, so the runner cache stays small.
export async function pruneExtracts(cacheDir, record, { maxAgeHours = 24, log = console.log } = {}) {
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  for (const [id, r] of Object.entries(record)) {
    if (r.usedAt && Date.parse(r.usedAt) >= cutoff) continue;
    const file = join(cacheDir, `${id}.osm.pbf`);
    if (await stat(file).then(() => true, () => false)) {
      await rm(file);
      log(`${id}: removed from the extract cache (unused for ${maxAgeHours} h)`);
    }
  }
}

// ids: one Geofabrik extract id, or a list of them. Downloads into cacheDir (see ensureExtract).
// Options: clip (bbox to keep, see clipOsmRoads), record, urls ({ id: link }), fetchFn.
export async function loadAreaRoads(ids, cacheDir, log = console.log, { clip = null, record = {}, urls = {}, fetchFn = fetch } = {}) {
  const list = Array.isArray(ids) ? ids : [ids];
  const parts = [];
  for (const id of list) {
    const file = await ensureExtract(id, cacheDir, { record, url: urls[id] ?? null, fetchFn, log });
    let part = loadOsmRoads(file);
    log(`${id}: ${part.ways.length} roads, ${part.relations.length} restrictions, ${(part.cameras ?? []).length} speed cameras`);
    if (clip) part = clipOsmRoads(part, clip);
    parts.push(part);
  }
  const merged = mergeOsmRoads(parts);
  log(`merged${clip ? " (clipped to the area)" : ""}: ${merged.ways.length} roads, ${merged.relations.length} restrictions, ${merged.cameras.length} speed cameras`);
  return merged;
}
