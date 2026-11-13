// Grows the published map area by area (county by county): England first, then Wales, Scotland
// and Northern Ireland. Each run builds the next areas in the order below, at most GROW_PER_RUN
// areas (default 1) within GROW_MINUTES minutes (default 240). An area cut short by the time
// limit is finished by the next run (its built squares are kept).
//
// Order: the areas named in growth.json "first", then each country of "phases" in turn. Within a
// country, the next area is the one whose bounding-box centre is nearest to something already
// built: a seed (Stockport, London) or a finished area. So the map grows outwards from them.
//
// Areas come from Geofabrik's index with boundaries (index-v1.json): the children of a country,
// or the country itself if Geofabrik has no children for it. A phase can instead name an extract
// and a bbox ({ id, extract, bbox }): Geofabrik has no Northern Ireland extract, so Northern
// Ireland is the part of "ireland-and-northern-ireland" inside its bbox. An area's squares are the grid
// squares of its bounding box that its boundary touches. Each square gets roads from every
// extract whose boundary touches a square that must be built, so border squares are complete,
// and only those extracts are downloaded (and only if Geofabrik has a newer copy than ours).
//
// Refresh: each run first rebuilds stale squares of finished areas, those whose index entry has
// another tile version or builder than the current ones, oldest first (by builtAt), at most
// GROW_REFRESH_SQUARES (default 400) per run and within the same time budget. Each stale square
// is rebuilt with the extracts its own area would use, and only those are downloaded. A square is
// replaced only by its newly built file, so a failed refresh loses nothing; the next run tries
// again. Progress is kept in growth.json "refresh".
//
// Large areas (Scotland has 21,390 squares) are built in batches of GROW_BATCH_SQUARES squares
// (default 1000): the extracts are read once for the whole area, keeping only the nodes of its
// roads, and each batch then holds only its own roads (see load-osm.mjs).
//
// Usage: node tools/grow.mjs [--dry-run] [--no-head]
//   --dry-run  print the plan (refresh, next areas, their squares, their extracts); download and build nothing
//   --no-head  with --dry-run: do not ask Geofabrik for extract sizes
// Environment: GROW_PER_RUN, GROW_MINUTES, GROW_REFRESH_SQUARES, GROW_BATCH_SQUARES, GROW_SHAPE
// ("boundary" or "bbox"), GROW_STATE (state file), GEOFABRIK_INDEX (index file or URL),
// GROW_TILE_VERSION (skip asking OpenFreeMap).

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchIndex, INDEX_GEOM, ringsOf, geometryBbox } from "./geofabrik.mjs";
import { SQUARES_PER_DEGREE, squareId, squareBbox, squaresTouching, squareRelease, squareUrl } from "./grid.mjs";
import { buildSquares, readSquaresIndex, isUpToDate, batchesOf, BUILDER_VERSION } from "./build-squares.mjs";
import { openAreaRoads, pruneExtracts } from "./osm-area.mjs";
import { sourceVersion } from "./fetch-tiles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_FILE = process.env.GROW_STATE || join(ROOT, "data", "published", "growth.json");
export const CACHE_DIR = join(ROOT, "data", "cache", "osm");
export const DEFAULT_REFRESH_SQUARES = 400;
export const DEFAULT_BATCH_SQUARES = 1000;

export const DEFAULT_STATE = {
  seeds: [
    { id: "stockport", lat: 53.4, lon: -2.16 },
    { id: "london", lat: 51.49, lon: -0.13 },
  ],
  phases: [
    "england",
    "wales",
    "scotland",
    { id: "northern-ireland", name: "Northern Ireland", extract: "ireland-and-northern-ireland", bbox: [-8.2, 54.0, -5.4, 55.35] },
  ],
  first: [],
  skip: [],
  zoom: 14,
  current: null,
  finished: [],
  lastRun: null,
  refresh: { refreshed: 0, lastRun: null },
  extracts: {},
};

export async function readGrowth(file = STATE_FILE) {
  let saved = {};
  try {
    saved = JSON.parse(await readFile(file, "utf8"));
  } catch {
    saved = {};
  }
  return { ...structuredClone(DEFAULT_STATE), ...saved };
}

export async function writeGrowth(state, file = STATE_FILE) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2) + "\n");
}

// --- geometry ---------------------------------------------------------------------------------

// Approximate distance in km between two [lat, lon] points (equirectangular; fine at UK scale).
export function distanceKm([lat1, lon1], [lat2, lon2]) {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return 6371 * Math.hypot(x, y);
}

// Centre of a lon-first bbox, as [lat, lon].
export function bboxCentre([minLon, minLat, maxLon, maxLat]) {
  return [(minLat + maxLat) / 2, (minLon + maxLon) / 2];
}

// Lon-first bbox covering a list of squares.
export function squaresBbox(squares) {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const sq of squares) {
    const [a, b, c, d] = squareBbox(sq);
    minLat = Math.min(minLat, a);
    minLon = Math.min(minLon, b);
    maxLat = Math.max(maxLat, c);
    maxLon = Math.max(maxLon, d);
  }
  return [minLon, minLat, maxLon, maxLat];
}

// Every grid square a GeoJSON Polygon or MultiPolygon touches: the squares its boundary passes
// through (found exactly, by cutting each edge at the grid lines), and the squares whose centre
// lies inside it (even-odd rule along each row, so holes are respected). Sorted by id.
export function squaresInGeometry(geometry) {
  const S = SQUARES_PER_DEGREE;
  const rings = ringsOf(geometry);
  const found = new Map();
  const add = (latIdx, lonIdx) => {
    const k = `${latIdx},${lonIdx}`;
    if (!found.has(k)) found.set(k, { latIdx, lonIdx });
  };
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      const ts = [0, 1];
      for (const [p, q] of [[x1, x2], [y1, y2]]) {
        if (p === q) continue;
        const lo = Math.min(p, q) * S;
        const hi = Math.max(p, q) * S;
        for (let g = Math.ceil(lo); g <= hi; g++) ts.push((g / S - p) / (q - p));
      }
      ts.sort((a, b) => a - b);
      for (let j = 0; j + 1 < ts.length; j++) {
        const t = (ts[j] + ts[j + 1]) / 2;
        add(Math.floor((y1 + (y2 - y1) * t) * S), Math.floor((x1 + (x2 - x1) * t) * S));
      }
      add(Math.floor(y1 * S), Math.floor(x1 * S));
    }
  }
  const [, minLat, , maxLat] = geometryBbox(geometry);
  for (let latIdx = Math.floor(minLat * S); latIdx <= Math.floor(maxLat * S); latIdx++) {
    const y = (latIdx + 0.5) / S;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        if ((y1 <= y) !== (y2 <= y)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let lonIdx = Math.ceil(xs[k] * S - 0.5); (lonIdx + 0.5) / S <= xs[k + 1]; lonIdx++) add(latIdx, lonIdx);
    }
  }
  return [...found.values()].sort((a, b) => a.latIdx - b.latIdx || a.lonIdx - b.lonIdx);
}

const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

// --- areas and order --------------------------------------------------------------------------

export const phaseId = (phase) => (typeof phase === "string" ? phase : phase.id);

function areaOf(feature, phase) {
  const p = feature.properties;
  if (!feature.geometry) throw new Error(`Geofabrik index has no boundary for "${p.id}": use ${INDEX_GEOM}`);
  return { id: p.id, extract: p.id, name: p.name, parent: p.parent, phase, url: p.urls?.pbf, geometry: feature.geometry, bbox: geometryBbox(feature.geometry), limit: null };
}

// Every area growth can build, in phase order: the children of each phase country, or the
// country itself when Geofabrik has no children for it. Also returns countries with no extract.
export function candidateAreas(index, state) {
  const areas = [];
  const missing = [];
  for (const entry of state.phases) {
    const phase = phaseId(entry);
    if (typeof entry !== "string") {
      // An extract cut down to a bbox.
      const f = index.features.find((x) => x.properties.id === entry.extract);
      if (!f) {
        missing.push(phase);
        continue;
      }
      const area = areaOf(f, phase);
      areas.push({ ...area, id: phase, name: entry.name ?? phase, bbox: entry.bbox, limit: entry.bbox });
      continue;
    }
    const children = index.features.filter((f) => f.properties.parent === phase);
    const self = index.features.filter((f) => f.properties.id === phase);
    const chosen = children.length ? children : self;
    if (!chosen.length) missing.push(phase);
    for (const f of chosen) areas.push(areaOf(f, phase));
  }
  return { areas, missing };
}

// The areas not yet finished, in the order they will be built. The area in progress comes
// first, then "first", then each phase, nearest to what is (or by then will be) built first.
export function orderAreas(areas, state) {
  const done = new Set(state.finished.map((f) => f.id));
  const skip = new Set(state.skip ?? []);
  const byId = new Map(areas.map((a) => [a.id, a]));
  const points = state.seeds.map((s) => ({ id: s.id, at: [s.lat, s.lon] }));
  for (const f of state.finished) if (byId.has(f.id)) points.push({ id: f.id, at: bboxCentre(byId.get(f.id).bbox) });
  const ordered = [];
  const take = (area) => {
    const near = nearestPoint(area, points);
    ordered.push({ ...area, distanceKm: near.km, nearest: near.id });
    done.add(area.id);
    points.push({ id: area.id, at: bboxCentre(area.bbox) });
  };
  const leftover = (a) => !done.has(a.id) && !skip.has(a.id);
  if (state.current && byId.has(state.current.id) && leftover(byId.get(state.current.id))) take(byId.get(state.current.id));
  for (const id of state.first ?? []) if (byId.has(id) && leftover(byId.get(id))) take(byId.get(id));
  for (const phase of state.phases.map(phaseId)) {
    let rest = areas.filter((a) => a.phase === phase && leftover(a));
    while (rest.length) {
      let best = null;
      for (const a of rest) {
        const km = nearestPoint(a, points).km;
        if (!best || km < best.km || (km === best.km && a.id < best.area.id)) best = { area: a, km };
      }
      take(best.area);
      rest = rest.filter((a) => a !== best.area);
    }
  }
  return ordered;
}

function nearestPoint(area, points) {
  const c = bboxCentre(area.bbox);
  let best = { id: null, km: Infinity };
  for (const p of points) {
    const km = distanceKm(c, p.at);
    if (km < best.km) best = { id: p.id, km };
  }
  return best;
}

// The squares an area builds: those its boundary touches ("boundary", default), or every square
// its bounding box touches ("bbox").
// An area cut down to a bbox ("limit") keeps only the squares touching that bbox.
export function squaresForArea(area, shape = "boundary") {
  if (shape === "bbox") return squaresTouching([area.bbox[1], area.bbox[0], area.bbox[3], area.bbox[2]]);
  const squares = squaresInGeometry(area.geometry);
  if (!area.limit) return squares;
  const keep = new Set(squaresTouching([area.limit[1], area.limit[0], area.limit[3], area.limit[2]]).map(squareId));
  return squares.filter((sq) => keep.has(squareId(sq)));
}

// The extracts areas are built from, once each: { id, url, geometry, bbox }.
export function extractPool(areas) {
  const pool = new Map();
  for (const a of areas) if (!pool.has(a.extract)) pool.set(a.extract, { id: a.extract, url: a.url, geometry: a.geometry, bbox: geometryBbox(a.geometry) });
  return [...pool.values()];
}

// The extracts (from extractPool) whose boundary touches at least one of the squares to build,
// the area's own extract first.
export function extractsFor(area, todo, pool, cache = new Map()) {
  if (todo.length === 0) return [];
  const want = new Set(todo.map(squareId));
  const box = squaresBbox(todo);
  const hits = [];
  for (const other of pool) {
    if (!overlaps(other.bbox, box)) continue;
    if (!cache.has(other.id)) cache.set(other.id, squaresInGeometry(other.geometry).map(squareId));
    if (cache.get(other.id).some((id) => want.has(id))) hits.push(other);
  }
  hits.sort((a, b) => (a.id === area.extract ? -1 : b.id === area.extract ? 1 : a.id.localeCompare(b.id)));
  return hits.map((a) => a.id);
}

// The next perRun areas, each with its squares, the squares still to build and the extracts
// it needs. Squares an earlier area of the same plan builds count as built.
export function planGrowth({ index, state, squaresIndex, version, perRun = 1, shape = "boundary" }) {
  const { areas, missing } = candidateAreas(index, state);
  const order = orderAreas(areas, state);
  const pool = extractPool(areas);
  const planned = new Set();
  const cache = new Map();
  const steps = [];
  for (const area of order.slice(0, perRun)) {
    const squares = squaresForArea(area, shape);
    const todo = squares.filter((sq) => !planned.has(squareId(sq)) && !isUpToDate(squaresIndex[squareId(sq)], version));
    for (const sq of todo) planned.add(squareId(sq));
    const bboxCount = squaresTouching([area.bbox[1], area.bbox[0], area.bbox[3], area.bbox[2]]).length;
    steps.push({ area, squares, todo, bboxCount, extracts: extractsFor(area, todo, pool, cache) });
  }
  return { steps, order, areas, missing };
}

// --- refresh -----------------------------------------------------------------------------------

// A built square is stale when it was built from other tiles or by another builder. With the tile
// version unknown (a dry run that cannot ask OpenFreeMap) only the builder is compared.
export function isStale(entry, version) {
  if (!entry) return false; // never built: not a refresh
  if (entry.builder !== BUILDER_VERSION) return true;
  return version != null && entry.version !== version;
}

// The stale squares of finished areas to rebuild this run: oldest first (builtAt, then id), at
// most cap. A square shared by two finished areas belongs to the one finished first. The
// selected squares are grouped by area (in order of their oldest square), each group with the
// extracts its squares need (as a normal build of that area would use).
// Returns { stale (count), selected: [{ id, sq, area, builtAt }], groups: [{ area, squares, extracts }] }.
export function planRefresh({ areas, state, squaresIndex, version, cap = DEFAULT_REFRESH_SQUARES, shape = "boundary" }) {
  const byId = new Map(areas.map((a) => [a.id, a]));
  const owner = new Map();
  for (const f of state.finished) {
    const area = byId.get(f.id);
    if (!area) continue;
    for (const sq of squaresForArea(area, shape)) {
      const id = squareId(sq);
      if (!owner.has(id)) owner.set(id, { id, sq, area });
    }
  }
  const stale = [];
  for (const o of owner.values()) {
    const entry = squaresIndex[o.id];
    if (isStale(entry, version)) stale.push({ ...o, builtAt: entry.builtAt ?? "" });
  }
  stale.sort((a, b) => (a.builtAt < b.builtAt ? -1 : a.builtAt > b.builtAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selected = stale.slice(0, Math.max(0, cap));
  const groups = new Map();
  for (const s of selected) {
    if (!groups.has(s.area.id)) groups.set(s.area.id, { area: s.area, squares: [] });
    groups.get(s.area.id).squares.push(s.sq);
  }
  const pool = extractPool(areas);
  const cache = new Map();
  for (const g of groups.values()) {
    g.squares.sort((a, b) => a.latIdx - b.latIdx || a.lonIdx - b.lonIdx);
    g.extracts = extractsFor(g.area, g.squares, pool, cache);
  }
  return { stale: stale.length, selected, groups: [...groups.values()] };
}

// Records an area as finished in the growth state.
export function recordFinished(state, area, { startedAt, finishedAt, squares, built, bytes, extracts }) {
  state.finished = state.finished.filter((f) => f.id !== area.id);
  state.finished.push({ id: area.id, name: area.name, phase: area.phase, startedAt, finishedAt, squares, built, bytes, extracts });
  if (state.current?.id === area.id) state.current = null;
  return state;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const fmtBbox = (b) => b.map((v) => v.toFixed(2)).join(",");

export function formatPlan(plan, state, { version, perRun, minutes, shape, heads = {}, refresh = null, refreshCap = DEFAULT_REFRESH_SQUARES, batchSquares = DEFAULT_BATCH_SQUARES }) {
  const lines = [];
  const total = plan.areas.length;
  const finished = state.finished.filter((f) => plan.areas.some((a) => a.id === f.id)).length;
  lines.push("Growth plan (dry run: nothing is downloaded or built)");
  lines.push(`tile version ${version ?? "unknown"}, builder ${BUILDER_VERSION}, squares by ${shape}`);
  lines.push(`per run: up to ${perRun} area(s) within ${minutes} min`);
  const perPhase = state.phases.map(phaseId).map((p) => {
    const all = plan.areas.filter((a) => a.phase === p);
    if (plan.missing.includes(p)) return `${p}: no Geofabrik extract`;
    return `${p} ${all.filter((a) => state.finished.some((f) => f.id === a.id)).length}/${all.length}`;
  });
  lines.push(`finished: ${finished} of ${total} areas (${perPhase.join(", ")})`);
  if (state.current) lines.push(`in progress: ${state.current.id} (started ${state.current.startedAt})`);
  if (refresh) {
    lines.push(`refresh: ${refresh.stale} stale square(s) in finished areas${version == null ? " (builder only: tile version unknown)" : ""}, up to ${refreshCap} per run, oldest first`);
    if (refresh.selected.length) {
      lines.push(`   next ${refresh.selected.length}, built ${refresh.selected[0].builtAt || "unknown"} .. ${refresh.selected[refresh.selected.length - 1].builtAt || "unknown"}: ` +
        refresh.groups.map((g) => `${g.area.id} ${g.squares.length} (extracts ${g.extracts.join(", ") || "none"})`).join("; "));
    }
  }
  if (plan.steps.length === 0) lines.push("nothing left to build");
  plan.steps.forEach((s, i) => {
    const a = s.area;
    lines.push(`${i + 1}. ${a.id} "${a.name}" (${a.phase}), ${a.distanceKm.toFixed(0)} km from ${a.nearest}`);
    lines.push(`   bbox ${fmtBbox(a.bbox)}: ${s.bboxCount} squares touch the bbox, ${s.squares.length} to publish, ${s.squares.length - s.todo.length} already up to date, ${s.todo.length} to build`);
    const rows = [...new Set(s.squares.map(squareRelease))];
    lines.push(`   releases: ${rows.length} rows (${rows[0]} .. ${rows[rows.length - 1]}), e.g. ${s.squares.length ? squareUrl(s.squares[0]) : "-"}`);
    lines.push(`   extracts (${s.extracts.length}): ${s.extracts.join(", ") || "none"}`);
    if (s.todo.length > batchSquares) lines.push(`   built in ${batchesOf(s.todo, batchSquares).length} batches of up to ${batchSquares} squares`);
    for (const id of s.extracts) {
      const h = heads[id];
      if (!h) continue;
      lines.push(`     ${id}: ${h.bytes != null ? mb(h.bytes) : "size unknown"}, Last-Modified ${h.lastModified ?? "unknown"}, ${h.cached ? "cached copy is current" : "would download"}`);
    }
  });
  const later = plan.order.slice(plan.steps.length, plan.steps.length + 12).map((a) => a.id);
  if (later.length) lines.push(`after that: ${later.join(", ")}${plan.order.length > plan.steps.length + 12 ? ", ..." : ""}`);
  return lines.join("\n");
}

// --- run ----------------------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const perRun = Math.max(1, Number(process.env.GROW_PER_RUN || 1));
  const minutes = Number(process.env.GROW_MINUTES || 240);
  const shape = process.env.GROW_SHAPE === "bbox" ? "bbox" : "boundary";
  const refreshCap = Math.max(0, Number(process.env.GROW_REFRESH_SQUARES ?? DEFAULT_REFRESH_SQUARES));
  const batchSquares = Math.max(1, Number(process.env.GROW_BATCH_SQUARES || DEFAULT_BATCH_SQUARES));
  const started = Date.now();
  const deadline = started + minutes * 60 * 1000;
  const state = await readGrowth();
  const index = await fetchIndex({ geometry: true });
  let source = null;
  if (process.env.GROW_TILE_VERSION) source = { version: process.env.GROW_TILE_VERSION, template: null };
  else {
    try {
      source = await sourceVersion();
    } catch (err) {
      if (!dryRun) throw err;
      console.log(`tile version unknown (${err.message})`);
    }
  }
  const version = source?.version ?? null;

  if (dryRun) {
    const squaresIndex = await readSquaresIndex();
    const plan = planGrowth({ index, state, squaresIndex, version, perRun, shape });
    const refresh = planRefresh({ areas: plan.areas, state, squaresIndex, version, cap: refreshCap, shape });
    const heads = {};
    if (!process.argv.includes("--no-head")) {
      const byId = new Map(extractPool(plan.areas).map((a) => [a.id, a]));
      for (const id of new Set(plan.steps.flatMap((s) => s.extracts))) {
        try {
          const res = await fetch(byId.get(id).url, { method: "HEAD" });
          const lastModified = res.headers.get("last-modified");
          const length = res.headers.get("content-length");
          const have = state.extracts[id];
          const size = await stat(join(CACHE_DIR, `${id}.osm.pbf`)).then((st) => st.size, () => -1);
          heads[id] = { lastModified, bytes: length ? Number(length) : null, cached: Boolean(have) && have.lastModified === lastModified && have.bytes === size };
        } catch (err) {
          heads[id] = { lastModified: `unknown (${err.message})`, bytes: null };
        }
      }
    }
    console.log(formatPlan(plan, state, { version, perRun, minutes, shape, heads, refresh, refreshCap, batchSquares }));
    return;
  }

  const run = { startedAt: new Date(started).toISOString(), finishedAt: null, areas: [], built: 0, refreshed: 0 };
  const urls = Object.fromEntries(extractPool(candidateAreas(index, state).areas).map((a) => [a.id, a.url]));
  // Roads for one batch of squares; the extracts are opened once, on the first batch.
  const roadsFor = (extracts, todo) => {
    let opened = null;
    return async (batch) => {
      opened ??= await openAreaRoads(extracts, CACHE_DIR, console.log, { clip: squaresBbox(todo), batched: todo.length > batchSquares, record: state.extracts, urls });
      return opened.batch(squaresBbox(batch));
    };
  };

  // 1. Refresh stale squares of finished areas.
  state.refresh ??= { refreshed: 0, lastRun: null };
  const refresh = planRefresh({ areas: candidateAreas(index, state).areas, state, squaresIndex: await readSquaresIndex(), version, cap: refreshCap, shape });
  if (refresh.selected.length) {
    const rec = {
      startedAt: new Date().toISOString(), finishedAt: null, stale: refresh.stale, selected: refresh.selected.length, built: 0,
      oldestBuiltAt: refresh.selected[0].builtAt || null, areas: [], extracts: [], errors: [], complete: true,
    };
    console.log(`refresh: ${refresh.stale} stale squares in finished areas; rebuilding ${refresh.selected.length}, oldest first`);
    for (const g of refresh.groups) {
      if (Date.now() >= deadline) {
        rec.complete = false;
        break;
      }
      console.log(`refresh: ${g.area.id}: ${g.squares.length} squares, extracts ${g.extracts.join(", ") || "none"}`);
      try {
        const result = await buildSquares({ squares: g.squares, zoom: state.zoom, source, deadline, log: console.log, batchSquares, loadOsmRoads: roadsFor(g.extracts, g.squares) });
        rec.built += result.built;
        if (!result.complete) rec.complete = false;
      } catch (err) {
        // The squares not rebuilt keep their old files and entries, and stay stale for the next run.
        console.log(`refresh: ${g.area.id} failed: ${err.message}`);
        rec.errors.push(`${g.area.id}: ${err.message}`);
      }
      rec.areas.push(g.area.id);
      for (const id of g.extracts) if (!rec.extracts.includes(id)) rec.extracts.push(id);
    }
    rec.finishedAt = new Date().toISOString();
    state.refresh.refreshed += rec.built;
    state.refresh.lastRun = rec;
    run.refreshed = rec.built;
    await writeGrowth(state); // progress is kept even when this run rebuilt nothing
    console.log(`refresh: ${rec.built} of ${rec.selected} rebuilt${rec.errors.length ? `, ${rec.errors.length} failed` : ""}`);
  }

  // 2. Grow.
  for (let n = 0; n < perRun && Date.now() < deadline; n++) {
    const squaresIndex = await readSquaresIndex();
    const plan = planGrowth({ index, state, squaresIndex, version, perRun: 1, shape });
    const step = plan.steps[0];
    if (!step) {
      console.log("growth: every area is finished");
      break;
    }
    const { area, squares, todo, extracts } = step;
    if (state.current?.id !== area.id) state.current = { id: area.id, startedAt: new Date().toISOString(), built: 0 };
    console.log(`growth: ${area.id} "${area.name}": ${squares.length} squares, ${todo.length} to build, extracts ${extracts.join(", ") || "none"}`);
    if (todo.length > batchSquares) console.log(`growth: built in batches of up to ${batchSquares} squares`);
    const result = await buildSquares({
      squares,
      zoom: state.zoom,
      source,
      deadline,
      log: console.log,
      batchSquares,
      loadOsmRoads: roadsFor(extracts, todo),
    });
    state.current.built += result.built;
    run.built += result.built;
    run.areas.push(area.id);
    if (!result.complete) {
      console.log(`growth: ${area.id} is not finished; the next run carries on`);
      await writeGrowth(state);
      break;
    }
    const bytes = squares.reduce((sum, sq) => sum + (result.index[squareId(sq)]?.bytes ?? 0), 0);
    recordFinished(state, area, {
      startedAt: state.current.startedAt,
      finishedAt: new Date().toISOString(),
      squares: squares.length,
      built: state.current.built,
      bytes,
      extracts,
    });
    console.log(`growth: ${area.id} finished: ${squares.length} squares, ${mb(bytes)} uncompressed`);
    await writeGrowth(state);
  }
  await pruneExtracts(CACHE_DIR, state.extracts);
  // A run that built nothing leaves the state file unchanged, so nothing is committed.
  if (run.areas.length || run.refreshed) {
    run.finishedAt = new Date().toISOString();
    state.lastRun = run;
    await writeGrowth(state);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
