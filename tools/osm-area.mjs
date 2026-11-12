// Loads the OSM roads for an area from one or more Geofabrik extracts, and merges them.
// An area near an extract's border needs its neighbours too: Stockport's south-east corner,
// for example, lies in Cheshire and Derbyshire, not Greater Manchester.
// Roads, restrictions and cameras that appear in two extracts are kept once.

import { mkdir, writeFile, stat } from "node:fs/promises";
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

// ids: one Geofabrik extract id, or a list of them. Downloads into cacheDir, skipping a
// download when the file is already there and less than 20 hours old.
export async function loadAreaRoads(ids, cacheDir, log = console.log) {
  const list = Array.isArray(ids) ? ids : [ids];
  await mkdir(cacheDir, { recursive: true });
  const parts = [];
  for (const id of list) {
    const file = join(cacheDir, `${id}.osm.pbf`);
    const fresh = await stat(file).then((s) => Date.now() - s.mtimeMs < 20 * 3600 * 1000, () => false);
    if (!fresh) {
      const url = await extractUrl(id);
      log(`${id}: downloading ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSM extract ${id}: HTTP ${res.status}`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
    }
    const part = loadOsmRoads(file);
    log(`${id}: ${part.ways.length} roads, ${part.relations.length} restrictions, ${(part.cameras ?? []).length} speed cameras`);
    parts.push(part);
  }
  const merged = mergeOsmRoads(parts);
  log(`merged: ${merged.ways.length} roads, ${merged.relations.length} restrictions, ${merged.cameras.length} speed cameras`);
  return merged;
}
