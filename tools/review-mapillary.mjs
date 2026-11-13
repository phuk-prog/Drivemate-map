// Compares Mapillary speed-limit sign detections with the speed limits in our published map squares
// (OpenStreetMap data) and writes review flags as GeoJSON, which GitHub shows on a map.
// The owner checks each flag against the Mapillary photo and, if OpenStreetMap is wrong, edits
// OpenStreetMap by hand. Nothing is ever sent to OpenStreetMap from here.
//
// Each sign is matched to the nearest road edge within 20 m. Flags:
//   SPEED_LIMIT          the sign differs from our maxspeed by more than 2 km/h (mph signs converted)
//   SPEED_LIMIT_MISSING  our road has no maxspeed
// Signs on the same road edge with the same value give one flag (the sign with the lowest id; the
// "signs" property counts them).
//
// Output: data/published/review/<area>.geojson for squares inside a regions.json squareArea, else
// data/published/review/<squareId>.geojson. Features are sorted and coordinates rounded so that git
// diffs stay small. An output file is left unchanged when its squares gave no signs at all (for
// example a token that sees no data) or when a Mapillary request failed.
//
// Usage:
//   node tools/review-mapillary.mjs [--scope=areas|all] [--squares=id,id]
//   node tools/review-mapillary.mjs --list-squares [--scope=areas|all]
//     prints "<squareId> <release>" for each published square in scope (for downloading).
// The token is read from MAPILLARY_TOKEN and never printed. Without it the review is skipped.
// Our own code. No third-party dependencies.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDmap, fromFixed7 } from "./dmap.mjs";
import { parseSquareId, squareBbox, squaresTouching, squareId } from "./grid.mjs";
import { fetchSpeedSigns, compareIds, KMH_PER_MPH } from "./mapillary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SQUARES_DIR = join(ROOT, "data", "published", "squares");
export const REVIEW_DIR = join(ROOT, "data", "published", "review");
export const MATCH_METRES = 20;
export const TOLERANCE_KMH = 2;
export const NOTE = "Check the Mapillary photo, then edit OpenStreetMap by hand.";
const ROAD_CLASSES = ["road", "motorway", "trunk road", "primary road", "secondary road", "tertiary road", "minor road", "service road", "track"];
const NO_MOTOR = 1 << 4;
const EARTH_M = 6371008.8;
const CELL_DEG = 0.0005; // edge index cell: about 55 m north-south, 33 m east-west at 53 degrees

// ---- matching ---------------------------------------------------------------------------------

// Grid index of the road edges' segments, for nearest-edge lookups.
export function edgeIndex(map) {
  const cells = new Map();
  const key = (cy, cx) => cy * 4000000 + cx;
  map.edges.forEach((e, ei) => {
    for (let k = 1; k < e.points.length; k++) {
      const [la1, lo1] = e.points[k - 1];
      const [la2, lo2] = e.points[k];
      const y0 = Math.floor(fromFixed7(Math.min(la1, la2)) / CELL_DEG);
      const y1 = Math.floor(fromFixed7(Math.max(la1, la2)) / CELL_DEG);
      const x0 = Math.floor(fromFixed7(Math.min(lo1, lo2)) / CELL_DEG);
      const x1 = Math.floor(fromFixed7(Math.max(lo1, lo2)) / CELL_DEG);
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const kk = key(cy, cx);
          let list = cells.get(kk);
          if (!list) cells.set(kk, (list = []));
          list.push(ei, k);
        }
      }
    }
  });
  return { map, cells, key };
}

// Distance in metres from a point to a segment, on a local flat projection around the point.
function segmentDistance(lat, lon, la1, lo1, la2, lo2) {
  const ky = (Math.PI / 180) * EARTH_M;
  const kx = ky * Math.cos((lat * Math.PI) / 180);
  const ax = (lo1 - lon) * kx, ay = (la1 - lat) * ky;
  const bx = (lo2 - lon) * kx, by = (la2 - lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// The nearest edge to a point within maxMetres: { edge, edgeIndex, distance } or null.
// Edges with no motor access are skipped (speed-limit signs are for motor traffic). Ties go to the
// lower edge index, so the result is stable.
export function nearestEdge(index, lat, lon, maxMetres = MATCH_METRES) {
  const cy = Math.floor(lat / CELL_DEG);
  const cx = Math.floor(lon / CELL_DEG);
  const reach = Math.max(1, Math.ceil(maxMetres / (CELL_DEG * 111320 * Math.cos((lat * Math.PI) / 180))));
  let best = null;
  for (let y = cy - reach; y <= cy + reach; y++) {
    for (let x = cx - reach; x <= cx + reach; x++) {
      const list = index.cells.get(index.key(y, x));
      if (!list) continue;
      for (let i = 0; i < list.length; i += 2) {
        const ei = list[i];
        const e = index.map.edges[ei];
        if (e.flags & NO_MOTOR) continue;
        const [la1, lo1] = e.points[list[i + 1] - 1];
        const [la2, lo2] = e.points[list[i + 1]];
        const d = segmentDistance(lat, lon, fromFixed7(la1), fromFixed7(lo1), fromFixed7(la2), fromFixed7(lo2));
        if (d <= maxMetres && (!best || d < best.distance || (d === best.distance && ei < best.edgeIndex))) best = { edge: e, edgeIndex: ei, distance: d };
      }
    }
  }
  return best;
}

export function roadLabel(map, e) {
  const name = map.strings[e.name] ?? "";
  const ref = map.strings[e.ref] ?? "";
  if (name && ref) return `${name} (${ref})`;
  return name || ref || ROAD_CLASSES[e.roadClass] || "road";
}

// Flags for one square: signs (from fetchSpeedSigns) against the square's map.
// Returns [{ kind, lat, lon, ours_kmh, sign_kmh, sign_mph, road, sign, distance, signs }].
export function reviewSquare(map, signs, { maxMetres = MATCH_METRES, toleranceKmh = TOLERANCE_KMH } = {}) {
  if (!signs.length || !map.edges.length) return [];
  const index = edgeIndex(map);
  const groups = new Map();
  for (const sign of [...signs].sort((a, b) => compareIds(a.id, b.id))) {
    const hit = nearestEdge(index, sign.lat, sign.lon, maxMetres);
    if (!hit) continue;
    const ours = hit.edge.maxspeed ?? 0;
    let kind = null;
    if (ours === 0) kind = "SPEED_LIMIT_MISSING";
    else if (Math.abs(sign.kmh - ours) > toleranceKmh) kind = "SPEED_LIMIT";
    if (!kind) continue;
    const key = `${kind}|${hit.edgeIndex}|${sign.unit}|${sign.value}`;
    const g = groups.get(key);
    if (g) {
      g.signs++;
      continue;
    }
    groups.set(key, {
      kind,
      lat: sign.lat,
      lon: sign.lon,
      ours_kmh: ours,
      sign_kmh: Math.round(sign.kmh),
      sign_mph: sign.mph,
      unit: sign.unit,
      road: roadLabel(map, hit.edge),
      sign,
      distance: hit.distance,
      signs: 1,
    });
  }
  return [...groups.values()];
}

// ---- GeoJSON ----------------------------------------------------------------------------------

const round = (v, dp) => Number(v.toFixed(dp));

export function mapillaryUrl(sign) {
  const lat = round(sign.lat, 6), lon = round(sign.lon, 6);
  if (sign.imageId) return `https://www.mapillary.com/app/?pKey=${encodeURIComponent(sign.imageId)}&lat=${lat}&lng=${lon}&z=18`;
  return `https://www.mapillary.com/app/?lat=${lat}&lng=${lon}&z=18&mapFeatureKey=${encodeURIComponent(sign.id)}`;
}

export function osmEditUrl(lat, lon) {
  return `https://www.openstreetmap.org/edit#map=19/${round(lat, 6)}/${round(lon, 6)}`;
}

export function flagFeature(f) {
  const lat = round(f.lat, 6), lon = round(f.lon, 6);
  const mph = f.unit === "mph";
  const sign = mph ? `${f.sign_mph} mph` : `${f.sign_kmh} km/h`;
  const ours = f.ours_kmh ? (mph ? `${Math.round(f.ours_kmh / KMH_PER_MPH)} mph (${f.ours_kmh} km/h)` : `${f.ours_kmh} km/h`) : "none";
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      kind: f.kind,
      title: `${f.road}: sign ${sign}, map ${ours}`,
      ours_kmh: f.ours_kmh,
      sign_kmh: f.sign_kmh,
      sign_mph: f.sign_mph,
      road: f.road,
      distance_m: Math.round(f.distance),
      signs: f.signs,
      mapillary_feature_id: f.sign.id,
      mapillary_url: mapillaryUrl(f.sign),
      osm_edit_url: osmEditUrl(lat, lon),
      note: NOTE,
      "marker-color": f.kind === "SPEED_LIMIT" ? "#d73027" : "#fc8d59",
    },
  };
}

export function sortFeatures(features) {
  return [...features].sort((a, b) => {
    const pa = a.properties, pb = b.properties;
    const [la, lo] = [a.geometry.coordinates[1], a.geometry.coordinates[0]];
    const [lb, lob] = [b.geometry.coordinates[1], b.geometry.coordinates[0]];
    return (pa.kind < pb.kind ? -1 : pa.kind > pb.kind ? 1 : 0) || lb - la || lo - lob || compareIds(pa.mapillary_feature_id, pb.mapillary_feature_id);
  });
}

// A FeatureCollection with one feature per line, so a changed flag is a one-line diff.
export function toGeoJson(flags) {
  const features = sortFeatures(flags.map(flagFeature));
  if (!features.length) return '{"type":"FeatureCollection","features":[]}\n';
  return '{"type":"FeatureCollection","features":[\n' + features.map((f) => JSON.stringify(f)).join(",\n") + "\n]}\n";
}

// ---- which squares belong where ---------------------------------------------------------------

// Map of squareId -> output name: the first squareArea that touches it, else the square id.
export function outputNames(squareIds, regions) {
  const areaOf = new Map();
  for (const area of regions?.squareAreas ?? []) {
    const [minLon, minLat, maxLon, maxLat] = area.bbox;
    for (const sq of squaresTouching([minLat, minLon, maxLat, maxLon])) {
      const id = squareId(sq);
      if (!areaOf.has(id)) areaOf.set(id, area.id);
    }
  }
  const out = new Map();
  for (const id of squareIds) out.set(id, areaOf.get(id) ?? id);
  return out;
}

// Published squares (from the squares index) in scope: "areas" = squares of the squareAreas, "all" = every one.
export function squaresInScope(index, regions, scope = "areas", only = null) {
  let ids = Object.keys(index ?? {}).filter((id) => parseSquareId(id));
  if (only && only.length) ids = ids.filter((id) => only.includes(id));
  else if (scope !== "all") {
    const names = outputNames(ids, regions);
    ids = ids.filter((id) => names.get(id) !== id);
  }
  return ids.sort();
}

// ---- run --------------------------------------------------------------------------------------

// Reviews every square file present in squaresDir that is in `ids`, and writes one GeoJSON file per
// output name. fetchSigns(bboxMapillaryOrder, squareId) returns signs (see fetchSpeedSigns).
// Returns { written: [names], kept: [names], failed: [squareIds], flags, signs }.
export async function runReview({ ids, regions, squaresDir = SQUARES_DIR, outDir = REVIEW_DIR, fetchSigns, log = console.log }) {
  const present = new Set((await readdir(squaresDir).catch(() => [])).filter((f) => f.endsWith(".dmap")).map((f) => f.replace(/\.dmap$/, "")));
  const todo = ids.filter((id) => present.has(id));
  const names = outputNames(todo, regions);
  const byName = new Map();
  for (const id of todo) {
    const n = names.get(id);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(id);
  }
  const result = { written: [], kept: [], failed: [], flags: 0, signs: 0 };
  await mkdir(outDir, { recursive: true });
  for (const [name, squareIds] of [...byName.entries()].sort()) {
    const flags = [];
    let signCount = 0;
    let failed = false;
    for (const id of squareIds) {
      const [minLat, minLon, maxLat, maxLon] = squareBbox(parseSquareId(id));
      let signs;
      try {
        signs = await fetchSigns([minLon, minLat, maxLon, maxLat], id);
      } catch (err) {
        // A refused token fails every request; stop at once instead of trying every square.
        if (err.status === 401 || err.status === 403) throw new Error(`Mapillary refused the token (HTTP ${err.status}). Check the MAPILLARY_TOKEN secret.`);
        log(`${id}: Mapillary failed: ${err.message}`);
        result.failed.push(id);
        failed = true;
        continue;
      }
      const map = readDmap(await readFile(join(squaresDir, `${id}.dmap`)));
      const found = reviewSquare(map, signs);
      signCount += signs.length;
      flags.push(...found);
      log(`${id}: ${signs.length} speed-limit sign(s), ${found.length} flag(s)`);
    }
    const file = join(outDir, `${name}.geojson`);
    if (failed || signCount === 0) {
      log(`${name}: ${failed ? "a Mapillary request failed" : "Mapillary returned no speed-limit signs"}; ${name}.geojson left as it was`);
      result.kept.push(name);
      continue;
    }
    const text = toGeoJson(flags);
    const old = await readFile(file, "utf8").catch(() => null);
    if (old !== text) await writeFile(file, text);
    log(`${name}: ${flags.length} flag(s) from ${signCount} sign(s)${old === text ? " (unchanged)" : ""}`);
    result.written.push(name);
    result.flags += flags.length;
    result.signs += signCount;
  }
  return result;
}

async function main() {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const scope = arg("scope") || "areas";
  if (scope !== "areas" && scope !== "all") throw new Error(`--scope must be areas or all, not ${scope}`);
  const only = arg("squares") ? arg("squares").split(",").map((s) => s.trim()).filter(Boolean) : null;
  const index = JSON.parse(await readFile(join(SQUARES_DIR, "index.json"), "utf8").catch(() => "{}"));
  const regions = JSON.parse(await readFile(join(ROOT, "regions.json"), "utf8").catch(() => "{}"));
  const ids = squaresInScope(index, regions, scope, only);

  if (process.argv.includes("--list-squares")) {
    for (const id of ids) console.log(`${id} ${index[id].release ?? "maps-latest"}`);
    return;
  }

  const token = process.env.MAPILLARY_TOKEN;
  if (!token) {
    console.log("MAPILLARY_TOKEN is not set, so the Mapillary review was skipped. Nothing was changed.");
    return;
  }
  if (!ids.length) {
    console.log("No published squares in scope. Nothing to review.");
    return;
  }
  let requests = 0;
  const fetchSigns = async (bbox) => {
    const signs = await fetchSpeedSigns(bbox, { token, requestsSoFar: requests, log: console.log });
    requests = signs.requests;
    return signs;
  };
  const r = await runReview({ ids, regions, fetchSigns });
  if (!r.written.length && !r.kept.length) console.log("No published square files were found locally. Nothing to review.");
  console.log(`Mapillary review: ${requests} request(s), ${r.signs} sign(s), ${r.flags} flag(s); written: ${r.written.join(", ") || "none"}; left as they were: ${r.kept.join(", ") || "none"}`);
  if (r.signs === 0 && r.kept.length) {
    const msg = "Mapillary returned no speed-limit signs for any square. Check that the MAPILLARY_TOKEN can read map features.";
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg);
  }
  if (r.failed.length) {
    console.error(`Mapillary requests failed for: ${r.failed.join(", ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
