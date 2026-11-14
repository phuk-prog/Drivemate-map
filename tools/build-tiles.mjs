// Builds offline vector map tiles for one region from an OpenStreetMap .osm.pbf extract.
// Our own code, with our own tile writer (tools/mvt-encode.mjs) and our own reader (tools/osm-pbf.mjs).
// Build-time only: the app reads the packed file, never the OSM file.
//
// Usage: node tools/build-tiles.mjs --pbf=greater-london.osm.pbf --name=london --bbox=-0.55,51.28,0.30,51.70 --minzoom=0 --maxzoom=14
// Output: data/tiles/<name>.dmtile (not committed)
//
// LAYERS (names and what is in them; the app's style must use the same names)
//   water     closed natural=water, water=* areas                    (polygon)
//   waterway  river, canal (from zoom 7), stream, drain, ditch (from zoom 12)  (line)
//   landuse   residential, commercial, industrial, forest, park, pitch, ...   (polygon) attr: class
//   building  building=* areas, from zoom 13                           (polygon) attr: class
//   road      highway=* lines, from zoom 4 (motorway) to zoom 15 (paths)  (line) attr: class, name?
//
// LIMITS (v1)
//   - Multipolygon relations are not built: only closed ways are areas. Holes and islands are lost.
//   - Points (place names, POIs) are not built yet.
//   - Ways with a node outside the extract are dropped, and counted in stats.
//
// CONTAINER (.dmtile, version 1)
//   bytes 0..7    "DMTILE01"
//   bytes 8..11   uint32 big-endian: length of the JSON index
//   then          JSON index: { format, version, tileFormat, encoding, extent, minzoom, maxzoom,
//                               bounds, name, attribution, layers, tiles: [[z, x, y, offset, length], ...] }
//   then          the tile data. Each tile is an MVT, gzip-compressed. offset is from the start of the data.

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { readPbf } from "./osm-pbf.mjs";
import { encodeTile } from "./mvt-encode.mjs";

export const EXTENT = 4096;
const BUFFER = 64;          // tile units kept outside each tile edge, so lines and fills join up
const TILE_PX = 256;        // screen size of one tile, used to drop areas too small to draw
export const ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";
const CONTAINER_MAGIC = "DMTILE01";

const LANDUSE = new Set(["residential", "commercial", "industrial", "retail", "forest", "farmland", "meadow", "grass", "cemetery", "recreation_ground", "village_green", "allotments", "orchard", "vineyard", "quarry", "brownfield", "construction"]);
const LEISURE = new Set(["park", "garden", "pitch", "playground", "golf_course", "nature_reserve", "recreation_ground"]);
const NATURAL_AREA = new Set(["wood", "scrub", "grassland", "heath", "beach", "sand", "bare_rock", "scree", "wetland"]);
const HIGHWAY = {
  motorway: 4, trunk: 5, primary: 7, secondary: 9, tertiary: 11, unclassified: 12, residential: 12,
  living_street: 13, service: 13, pedestrian: 13, track: 14,
  footway: 15, path: 15, cycleway: 15, bridleway: 15, steps: 15,
  motorway_link: 6, trunk_link: 7, primary_link: 8, secondary_link: 10, tertiary_link: 12,
};

/**
 * Which layer a way belongs to, from its tags. closed = first node equals last node.
 * Returns { layer, cls, minZoom, polygon, minPx, name? } or null when the way is not drawn.
 */
export function classify(tags, closed) {
  const t = tags || {};
  if (closed && t.building && t.building !== "no") return { layer: "building", cls: t.building, minZoom: 13, polygon: true, minPx: 0 };
  if (closed && (t.natural === "water" || t.water)) return { layer: "water", cls: "water", minZoom: 6, polygon: true, minPx: 2 };
  if (t.waterway) {
    if (t.waterway === "river" || t.waterway === "canal") return { layer: "waterway", cls: t.waterway, minZoom: 7, polygon: false, minPx: 0 };
    if (["stream", "drain", "ditch"].includes(t.waterway)) return { layer: "waterway", cls: t.waterway, minZoom: 12, polygon: false, minPx: 0 };
    return null;
  }
  if (closed) {
    const cls = LANDUSE.has(t.landuse) ? t.landuse : LEISURE.has(t.leisure) ? t.leisure : NATURAL_AREA.has(t.natural) ? t.natural : null;
    if (cls) return { layer: "landuse", cls, minZoom: 9, polygon: true, minPx: 2 };
  }
  if (t.highway && HIGHWAY[t.highway] !== undefined) {
    const r = { layer: "road", cls: t.highway, minZoom: HIGHWAY[t.highway], polygon: false, minPx: 0 };
    if (t.name) r.name = t.name;
    return r;
  }
  return null;
}

// ---- Web Mercator, in world units: x and y run 0..1 from the top-left corner ----

export function mercator(lon, lat) {
  const la = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2];
}

// Tile indexes that a bounding box (in world units) touches, at zoom z.
export function tileRange(minx, miny, maxx, maxy, z) {
  const n = 2 ** z;
  const clamp = (v) => Math.max(0, Math.min(n - 1, v));
  return {
    x0: clamp(Math.floor(minx * n)), x1: clamp(Math.floor(maxx * n)),
    y0: clamp(Math.floor(miny * n)), y1: clamp(Math.floor(maxy * n)),
  };
}

// ---- Clipping in tile units (0..EXTENT, with BUFFER outside) ----

// Sutherland-Hodgman against one edge of the clip box.
function clipRingEdge(pts, inside, cross) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i + pts.length - 1) % pts.length];
    const b = pts[i];
    const ai = inside(a), bi = inside(b);
    if (bi) {
      if (!ai) out.push(cross(a, b));
      out.push(b);
    } else if (ai) {
      out.push(cross(a, b));
    }
  }
  return out;
}

export function clipPolygon(ring) {
  const lo = -BUFFER, hi = EXTENT + BUFFER;
  let pts = ring;
  const crossX = (x) => (a, b) => { const t = (x - a[0]) / (b[0] - a[0]); return [x, a[1] + t * (b[1] - a[1])]; };
  const crossY = (y) => (a, b) => { const t = (y - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y]; };
  pts = clipRingEdge(pts, (p) => p[0] >= lo, crossX(lo));
  if (pts.length) pts = clipRingEdge(pts, (p) => p[0] <= hi, crossX(hi));
  if (pts.length) pts = clipRingEdge(pts, (p) => p[1] >= lo, crossY(lo));
  if (pts.length) pts = clipRingEdge(pts, (p) => p[1] <= hi, crossY(hi));
  return pts;
}

// Liang-Barsky clip of one segment to the box. Returns [p, q] or null.
function clipSegment(a, b) {
  const lo = -BUFFER, hi = EXTENT + BUFFER;
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const edges = [[-dx, a[0] - lo], [dx, hi - a[0]], [-dy, a[1] - lo], [dy, hi - a[1]]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

// A line clipped to the box, as a list of pieces (each a list of points).
export function clipLine(pts) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const s = clipSegment(pts[i], pts[i + 1]);
    if (!s) { cur = null; continue; }
    if (cur && cur[cur.length - 1][0] === s[0][0] && cur[cur.length - 1][1] === s[0][1]) cur.push(s[1]);
    else { cur = [s[0], s[1]]; pieces.push(cur); }
  }
  return pieces;
}

// Round to whole tile units and drop repeated points.
function quantise(pts) {
  const out = [];
  for (const [x, y] of pts) {
    const p = [Math.round(x), Math.round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

/**
 * The features of one tile, clipped and in tile units, for the given zoom.
 * features: [{ layer, cls, name?, polygon, minZoom, minPx, pts: [[x, y] in world units]}]
 * Returns { [layerName]: [{ type, tags, parts }] }.
 */
export function tileContent(features, z, x, y) {
  const n = 2 ** z;
  const out = {};
  const tx = (p) => [(p[0] * n - x) * EXTENT, (p[1] * n - y) * EXTENT];
  for (const f of features) {
    const pts = f.pts.map(tx);
    let parts;
    if (f.polygon) {
      const c = clipPolygon(pts);
      if (c.length < 3) continue;
      parts = [quantise(c)];
      if (parts[0].length < 3) continue;
    } else {
      parts = clipLine(pts).map(quantise).filter((p) => p.length >= 2);
      if (!parts.length) continue;
    }
    const tags = { class: f.cls };
    if (f.name) tags.name = f.name;
    (out[f.layer] ||= []).push({ type: f.polygon ? 3 : 2, tags, parts });
  }
  return out;
}

/** True when a feature is too small to draw at zoom z. */
export function tooSmall(f, z) {
  if (!f.polygon || !f.minPx) return false;
  const n = 2 ** z;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of f.pts) {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  return Math.max(maxx - minx, maxy - miny) * n * TILE_PX < f.minPx;
}

/**
 * Builds every tile for the features, from minZoom to maxZoom.
 * Returns an array of { z, x, y, data: gzipped MVT Buffer, layers: [names] }.
 */
export function buildTiles(features, minZoom, maxZoom) {
  const tiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const byTile = new Map();
    for (const f of features) {
      if (z < f.minZoom || tooSmall(f, z)) continue;
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const [x, y] of f.pts) {
        minx = Math.min(minx, x); maxx = Math.max(maxx, x);
        miny = Math.min(miny, y); maxy = Math.max(maxy, y);
      }
      const r = tileRange(minx, miny, maxx, maxy, z);
      for (let x = r.x0; x <= r.x1; x++) {
        for (let y = r.y0; y <= r.y1; y++) {
          const key = x + "/" + y;
          if (!byTile.has(key)) byTile.set(key, []);
          byTile.get(key).push(f);
        }
      }
    }
    for (const [key, list] of byTile) {
      const [x, y] = key.split("/").map(Number);
      const content = tileContent(list, z, x, y);
      const layers = Object.entries(content).map(([name, features]) => ({ name, extent: EXTENT, features }));
      if (!layers.length) continue;
      tiles.push({ z, x, y, data: gzipSync(encodeTile(layers)), layers: layers.map((l) => l.name) });
    }
  }
  return tiles;
}

/** Packs tiles into one .dmtile file. meta: { name, bounds, minzoom, maxzoom }. */
export function packContainer(tiles, meta) {
  const sorted = [...tiles].sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
  const index = [];
  let offset = 0;
  const layerNames = new Set();
  for (const t of sorted) {
    index.push([t.z, t.x, t.y, offset, t.data.length]);
    offset += t.data.length;
    t.layers.forEach((l) => layerNames.add(l));
  }
  const json = Buffer.from(JSON.stringify({
    format: "dmtile", version: 1, tileFormat: "mvt", encoding: "gzip", extent: EXTENT,
    minzoom: meta.minzoom, maxzoom: meta.maxzoom, bounds: meta.bounds, name: meta.name,
    attribution: ATTRIBUTION, layers: [...layerNames].sort(), tiles: index,
  }), "utf8");
  const head = Buffer.alloc(12);
  head.write(CONTAINER_MAGIC, 0, "ascii");
  head.writeUInt32BE(json.length, 8);
  return Buffer.concat([head, json, ...sorted.map((t) => t.data)]);
}

/** Reads a .dmtile file. Returns { index, tile(z, x, y) -> uncompressed MVT Buffer | null }. */
export function readContainer(buf) {
  if (buf.toString("ascii", 0, 8) !== CONTAINER_MAGIC) throw new Error("not a .dmtile file");
  const jsonLen = buf.readUInt32BE(8);
  const index = JSON.parse(buf.toString("utf8", 12, 12 + jsonLen));
  const dataStart = 12 + jsonLen;
  const byKey = new Map(index.tiles.map(([z, x, y, off, len]) => [z + "/" + x + "/" + y, [off, len]]));
  return {
    index,
    tile(z, x, y) {
      const e = byKey.get(z + "/" + x + "/" + y);
      if (!e) return null;
      return gunzipSync(buf.subarray(dataStart + e[0], dataStart + e[0] + e[1]));
    },
  };
}

// ---- Reading the extract ----

function tagsOf(keys, vals, block) {
  const out = {};
  for (let i = 0; i < keys.length; i++) out[block.str(keys[i])] = block.str(vals[i]);
  return out;
}

/**
 * Reads an .osm.pbf file and returns the features in the bounding box, plus stats.
 * bbox = [minLon, minLat, maxLon, maxLat] in degrees.
 */
export async function readFeatures(pbfPath, bbox) {
  const stats = { waysSeen: 0, waysKept: 0, waysMissingNodes: 0, waysOutsideBox: 0, byLayer: {} };
  const ways = [];
  const needed = new Set();

  // Pass 1: the ways we draw. Their node ids are needed for pass 2.
  await readPbf(pbfPath, {
    onWay(w, block) {
      stats.waysSeen++;
      const refs = w.refs;
      if (refs.length < 2) return;
      const tags = tagsOf(w.keys, w.vals, block);
      const closed = refs.length > 3 && refs[0] === refs[refs.length - 1];
      const c = classify(tags, closed);
      if (!c) return;
      ways.push({ refs, tags, c, closed });
      for (const r of refs) needed.add(r);
    },
  });

  // Pass 2: coordinates of those nodes only. Units are 1e-7 degrees.
  const coords = new Map();
  await readPbf(pbfPath, {
    onNode(id, lat, lon) {
      if (needed.has(id)) coords.set(id, [lon / 1e7, lat / 1e7]);
    },
  });

  const [minLon, minLat, maxLon, maxLat] = bbox;
  const features = [];
  for (const w of ways) {
    const pts = [];
    let missing = false;
    for (const r of w.refs) {
      const p = coords.get(r);
      if (!p) { missing = true; break; }
      pts.push(p);
    }
    if (missing) { stats.waysMissingNodes++; continue; }
    const inBox = pts.some(([lon, lat]) => lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat);
    if (!inBox) { stats.waysOutsideBox++; continue; }
    const polygon = w.c.polygon && w.closed;
    if (w.c.polygon && !w.closed) continue; // an open way cannot be an area
    const f = { layer: w.c.layer, cls: w.c.cls, polygon, minZoom: w.c.minZoom, minPx: w.c.minPx, pts: pts.map(([lon, lat]) => mercator(lon, lat)) };
    if (w.c.name) f.name = w.c.name;
    features.push(f);
    stats.waysKept++;
    stats.byLayer[f.layer] = (stats.byLayer[f.layer] || 0) + 1;
  }
  return { features, stats };
}

/** Full build for one region. Returns { buffer, stats }. */
export async function buildRegion({ pbfPath, name, bbox, minZoom = 0, maxZoom = 14 }) {
  const { features, stats } = await readFeatures(pbfPath, bbox);
  const tiles = buildTiles(features, minZoom, maxZoom);
  stats.tilesByZoom = {};
  let bytes = 0;
  for (const t of tiles) { stats.tilesByZoom[t.z] = (stats.tilesByZoom[t.z] || 0) + 1; bytes += t.data.length; }
  stats.tileBytes = bytes;
  const buffer = packContainer(tiles, { name, bounds: bbox, minzoom: minZoom, maxzoom: maxZoom });
  stats.fileBytes = buffer.length;
  return { buffer, stats };
}

// ---- Command line ----

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }));
  if (!args.pbf || !args.name || !args.bbox) {
    console.error("usage: node tools/build-tiles.mjs --pbf=<file.osm.pbf> --name=<region> --bbox=minLon,minLat,maxLon,maxLat [--minzoom=0] [--maxzoom=14]");
    process.exit(2);
  }
  const bbox = args.bbox.split(",").map(Number);
  const { buffer, stats } = await buildRegion({
    pbfPath: args.pbf, name: args.name, bbox,
    minZoom: Number(args.minzoom ?? 0), maxZoom: Number(args.maxzoom ?? 14),
  });
  const dir = join(ROOT, "data", "tiles");
  await mkdir(dir, { recursive: true });
  const out = join(dir, args.name + ".dmtile");
  await writeFile(out, buffer);
  console.log(JSON.stringify({ out, ...stats }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
