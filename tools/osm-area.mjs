// Loads the OSM roads for an area from one or more Geofabrik extracts, and merges them.
// An area near an extract's border needs its neighbours too: Stockport's south-east corner,
// for example, lies in Cheshire and Derbyshire, not Greater Manchester.
// Roads, restrictions and cameras that appear in two extracts are kept once.
// Node coordinates are CoordStores (typed arrays, see coord-store.mjs), not Maps, so very large
// extracts fit; an area too large to hold at once is read in batches (openAreaRoads).

import { mkdir, stat, rename, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { extractUrl, fetchWithRetry } from "./geofabrik.mjs";
import { openOsmRoads } from "./load-osm.mjs";
import { CoordStore, IdList } from "./coord-store.mjs";

export function mergeOsmRoads(parts) {
  const ways = new Map();
  const relations = new Map();
  const cameras = new Map();
  for (const p of parts) {
    for (const w of p.ways) ways.set(w.id, w);
    for (const r of p.relations) relations.set(r.id, r);
    for (const c of p.cameras ?? []) cameras.set(`${c.lat},${c.lon}`, c);
  }
  const coords = parts.length === 1 ? CoordStore.from(parts[0].coords) : CoordStore.merge(parts.map((p) => p.coords));
  return { ways: [...ways.values()], relations: [...relations.values()], coords, cameras: [...cameras.values()] };
}

// Keeps only the roads with a node inside bbox ([minLon, minLat, maxLon, maxLat]), their nodes,
// the restrictions whose via node is one of those nodes, and the cameras inside bbox.
// A square inside bbox gets exactly the roads it would get from the whole extract, and a
// county's roads fit in memory even when several large extracts are merged.
// coords: a Map or a CoordStore; the result's coords is a CoordStore.
export function clipOsmRoads({ ways, relations, coords, cameras = [] }, bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const store = CoordStore.from(coords);
  const inside = (c) => c && c[0] >= minLat && c[0] <= maxLat && c[1] >= minLon && c[1] <= maxLon;
  const keptWays = ways.filter((w) => w.nodes.some((n) => inside(store.get(n))));
  const ids = new IdList();
  for (const w of keptWays) for (const n of w.nodes) if (store.has(n)) ids.push(n);
  const keptCoords = store.pick(ids.finish());
  const keptRelations = relations.filter((r) => r.members.some((m) => m.type === "node" && m.role === "via" && keptCoords.has(m.ref)));
  const keptCameras = cameras.filter((c) => inside([c.lat, c.lon]));
  return { ways: keptWays, relations: keptRelations, coords: keptCoords, cameras: keptCameras };
}

// Makes sure cacheDir holds the current copy of one extract, and returns its path.
// record: { [id]: { lastModified, bytes, url, downloadedAt, usedAt } }, kept by the caller in
// data/published/growth.json. The file is downloaded again only when Geofabrik's Last-Modified
// (asked with HEAD) differs from the copy we have, or we have no copy.
// Network errors and HTTP 5xx/429 are retried (see fetchWithRetry; retryDelays in ms).
export async function ensureExtract(id, cacheDir, { record = {}, url = null, fetchFn = fetch, log = console.log, retryDelays } = {}) {
  await mkdir(cacheDir, { recursive: true });
  const file = join(cacheDir, `${id}.osm.pbf`);
  const link = url ?? (await extractUrl(id));
  const have = record[id];
  const size = await stat(file).then((s) => s.size, () => -1);
  let remote = null;
  try {
    const head = await fetchWithRetry(link, { method: "HEAD" }, { fetchFn, log, label: `${id} (HEAD)`, delays: retryDelays });
    if (head.ok) remote = head.headers.get("last-modified");
  } catch (err) {
    log(`${id}: HEAD request failed (${err.message})`);
  }
  const current = have && size === have.bytes && (remote === null || remote === have.lastModified);
  if (current) {
    log(`${id}: cached copy is current (Last-Modified ${have.lastModified})`);
  } else {
    log(`${id}: downloading ${link}`);
    const part = `${file}.part`;
    // Streamed to disk (never held in memory), and tried again from the start when the
    // connection fails part way.
    const res = await fetchWithRetry(link, {}, {
      fetchFn,
      log,
      label: `OSM extract ${id}`,
      delays: retryDelays,
      consume: async (r) => {
        await pipeline(Readable.fromWeb(r.body), createWriteStream(part));
        return r;
      },
    });
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

const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;

// Opens the extracts of an area, keeping only what the area needs (see load-osm.mjs).
// ids: one Geofabrik extract id, or a list of them. Downloads into cacheDir (see ensureExtract).
// Options: clip (the area's bbox, [minLon, minLat, maxLon, maxLat]), batched (true: the area is
// read batch by batch, so its roads are never all in memory), record, urls ({ id: link }), fetchFn.
// Returns { batch(bbox): merged roads touching bbox (a bbox inside clip), roads: all the area's
// roads (null when batched) }.
export async function openAreaRoads(ids, cacheDir, log = console.log, { clip = null, batched = false, record = {}, urls = {}, fetchFn = fetch, retryDelays } = {}) {
  const list = Array.isArray(ids) ? ids : [ids];
  const opened = [];
  for (const id of list) {
    const file = await ensureExtract(id, cacheDir, { record, url: urls[id] ?? null, fetchFn, log, retryDelays });
    const started = Date.now();
    const x = openOsmRoads(file, { bbox: clip, keepWays: !batched });
    const s = x.stats;
    log(`${id}: ${s.roadWays} roads (${s.roadNodes} nodes); ${clip ? `${s.areaWays ?? "batched:"} in the area, ` : ""}${s.areaNodes} nodes kept (${mb(s.coordBytes)}), ` +
      `${x.roads ? `${x.roads.relations.length} restrictions, ${x.roads.cameras.length} speed cameras, ` : ""}${((Date.now() - started) / 1000).toFixed(1)} s, heap ${mb(process.memoryUsage().heapUsed)}`);
    opened.push(x);
  }
  const roads = batched ? null : mergeOsmRoads(opened.map((x) => x.roads));
  if (roads) log(`merged${clip ? " (clipped to the area)" : ""}: ${roads.ways.length} roads, ${roads.relations.length} restrictions, ${roads.cameras.length} speed cameras`);
  return {
    roads,
    batch(bbox) {
      if (roads && (!clip || (bbox[0] <= clip[0] && bbox[1] <= clip[1] && bbox[2] >= clip[2] && bbox[3] >= clip[3]))) return roads;
      const merged = mergeOsmRoads(opened.map((x) => x.batch(bbox)));
      log(`batch ${bbox.map((v) => v.toFixed(2)).join(",")}: ${merged.ways.length} roads, ${merged.coords.size} nodes, heap ${mb(process.memoryUsage().heapUsed)}`);
      return merged;
    },
  };
}

// The merged roads of an area, all at once. Options as openAreaRoads (without batched).
export async function loadAreaRoads(ids, cacheDir, log = console.log, options = {}) {
  return (await openAreaRoads(ids, cacheDir, log, { ...options, batched: false })).roads;
}
