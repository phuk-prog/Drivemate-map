// Builds one DMAP (version 2) area file from cached OpenStreetMap vector tiles.
// Usage: node tools/build-area.mjs --name=london --bbox=-0.55,51.28,0.30,51.70 --zoom=14
// Output: data/out/<name>.dmap (not committed; published to static hosting later)

import { readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeTile } from "./mvt.mjs";
import { readCachedTile, tilesForBbox } from "./fetch-tiles.mjs";
import { writeDmap, toFixed7 } from "./dmap.mjs";
import { splitAtSharedVertices } from "./graph.mjs";
import { buildRoadGraph, speedCameraLabels } from "./osm-roads.mjs";
import { ROAD_CLASS, LINE_KIND, POLYGON_KIND, PLACE_CATEGORY, POI_CATEGORY, LABEL_KIND, roadLineKind } from "./classes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP_TOLERANCE = 200; // in 1e-7 degree units: about 2 m

// Tile-space point to [lat, lon] in 1e-7 degree units.
function tileToFixed(z, tx, ty, px, py, extent) {
  const n = 2 ** z;
  const x = tx + px / extent;
  const y = ty + py / extent;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [toFixed7(lat), toFixed7(lon)];
}

function insideTile(px, py, extent) {
  return px >= 0 && px <= extent && py >= 0 && py <= extent;
}

// Split a line into runs of points inside the tile. Each run keeps the
// neighbouring point just outside the tile, so features join across tile seams.
function ownedRuns(points, extent) {
  const runs = [];
  let current = null;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    if (insideTile(x, y, extent)) {
      if (!current) {
        current = [];
        if (i > 0) current.push(points[i - 1]);
      }
      current.push([x, y]);
    } else if (current) {
      current.push([x, y]);
      runs.push(current);
      current = null;
    }
  }
  if (current && current.length >= 2) runs.push(current);
  return runs.filter((r) => r.length >= 2);
}

class NodeIndex {
  constructor() {
    this.nodes = [];
    this.cells = new Map();
  }

  // Returns the ID of an existing node within SNAP_TOLERANCE, or creates one.
  get([lat, lon]) {
    const ci = Math.floor(lat / SNAP_TOLERANCE);
    const cj = Math.floor(lon / SNAP_TOLERANCE);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const ids = this.cells.get(`${ci + di},${cj + dj}`);
        if (!ids) continue;
        for (const id of ids) {
          const n = this.nodes[id];
          if (Math.abs(n.lat - lat) <= SNAP_TOLERANCE && Math.abs(n.lon - lon) <= SNAP_TOLERANCE) {
            return id;
          }
        }
      }
    }
    const id = this.nodes.length;
    this.nodes.push({ lat, lon });
    const key = `${ci},${cj}`;
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(id);
    return id;
  }
}

// 3D attributes from OpenMapTiles building tags. Heights are stored in decimetres; 0 means unknown.
function buildingAttrs(tags) {
  const h = Number(tags.render_height);
  const m = Number(tags.render_min_height);
  const hex = typeof tags.colour === "string" && /^#[0-9a-f]{6}$/i.test(tags.colour) ? parseInt(tags.colour.slice(1), 16) : 0;
  return {
    height: h > 0 ? Math.min(65535, Math.round(h * 10)) : 0,
    minHeight: m > 0 ? Math.min(65535, Math.round(m * 10)) : 0,
    colour: hex,
  };
}

// Representative point of a feature in tile space: the middle vertex of its longest part.
function anchorPoint(parts) {
  let best = null;
  for (const part of parts) if (!best || part.length > best.length) best = part;
  if (!best || best.length === 0) return null;
  return best[Math.floor(best.length / 2)];
}

// Average of the first ring's vertices, used to place a name inside an area.
function centroidPoint(parts) {
  const ring = parts[0];
  if (!ring || ring.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  return [sx / ring.length, sy / ring.length];
}

// osmRoads (optional): { ways, coords, relations, cameras } from load-osm.mjs. When given, routable
// roads come from OpenStreetMap (names, speed limits, lanes, restrictions) instead of the tiles,
// and fixed speed cameras inside the area are added as labels of kind 7.
export async function buildArea({ name, bbox, zoom, version, osmRoads = null, log = console.log }) {
  const cacheRoot = join(ROOT, "data", "cache", version);
  const tiles = tilesForBbox(bbox, zoom);
  const nodes = new NodeIndex();
  const edges = [];
  const lines = [];
  const polygons = [];
  const polygonKeys = new Set();
  const labels = [];
  const labelKeys = new Set();
  const counts = { edges: {}, lines: {}, polygons: {}, labels: {} };
  let dropped = 0;

  const addLabel = (kind, category, [lat, lon], text) => {
    const key = `${kind}|${text}|${lat}|${lon}`;
    if (labelKeys.has(key)) return;
    labelKeys.add(key);
    labels.push({ kind, category, lat, lon, name: text });
    counts.labels[kind] = (counts.labels[kind] || 0) + 1;
  };

  for (const t of tiles) {
    const buf = await readCachedTile(cacheRoot, t.z, t.x, t.y);
    if (!buf || buf.length === 0) continue;
    const byName = Object.fromEntries(decodeTile(buf).map((l) => [l.name, l]));
    const toFixed = (px, py, extent) => tileToFixed(t.z, t.x, t.y, px, py, extent);

    // Roads: routable edges.
    const transport = byName.transportation;
    if (transport) {
      for (const f of transport.features) {
        if (f.type !== 2) continue;
        const roadClass = ROAD_CLASS[f.tags.class];
        if (!roadClass) continue;
        let flags = 0;
        if (f.tags.brunnel === "bridge") flags |= 2;
        if (f.tags.brunnel === "tunnel") flags |= 4;
        if (f.tags.toll) flags |= 8;
        if (f.tags.access === "no" || f.tags.access === "private") flags |= 16;
        const ow = f.tags.oneway;
        const reverse = ow === -1;
        if (ow === 1 || ow === -1) flags |= 1;

        for (const part of f.parts) {
          for (const run of ownedRuns(part, transport.extent)) {
            const ordered = reverse ? run.slice().reverse() : run;
            const points = ordered.map(([x, y]) => toFixed(x, y, transport.extent));
            const from = nodes.get(points[0]);
            const to = nodes.get(points[points.length - 1]);
            if (from === to && points.length < 3) {
              dropped++;
              continue;
            }
            edges.push({ from, to, roadClass, flags, points });
            counts.edges[f.tags.class] = (counts.edges[f.tags.class] || 0) + 1;
          }
        }
      }
    }

    // Lines that are not routed: rail, transit, ferries, piers, footpaths, waterways, boundaries.
    const lineSources = [
      { layer: "transportation", kindOf: (f) => (f.type === 2 ? roadLineKind(f.tags.class, f.tags.subclass) : null), level: () => 0 },
      { layer: "waterway", kindOf: (f) => (f.type === 2 ? LINE_KIND.waterway[f.tags.class] ?? null : null), level: () => 0 },
      { layer: "boundary", kindOf: (f) => (f.type === 2 ? LINE_KIND.boundary : null), level: (f) => Math.min(255, Number(f.tags.admin_level) || 0) },
      { layer: "aeroway", kindOf: (f) => (f.type === 2 ? LINE_KIND.aeroway : null), level: () => 0 },
    ];
    for (const src of lineSources) {
      const l = byName[src.layer];
      if (!l) continue;
      for (const f of l.features) {
        const kind = src.kindOf(f);
        if (!kind || ROAD_CLASS[f.tags.class] && src.layer === "transportation") continue;
        const level = src.level(f);
        for (const part of f.parts) {
          for (const run of ownedRuns(part, l.extent)) {
            lines.push({ kind, level, points: run.map(([x, y]) => toFixed(x, y, l.extent)) });
            counts.lines[kind] = (counts.lines[kind] || 0) + 1;
          }
        }
      }
    }

    // Areas: landcover, landuse, parks, water, buildings, piers.
    for (const layerName of ["landcover", "landuse", "park", "water", "building", "transportation", "aeroway"]) {
      const l = byName[layerName];
      if (!l) continue;
      for (const f of l.features) {
        if (f.type !== 3) continue;
        const kind = POLYGON_KIND.area(layerName, f.tags);
        if (!kind) continue;
        const inside = f.parts.some((ring) => ring.some(([x, y]) => insideTile(x, y, l.extent)));
        if (!inside) continue;
        const rings = f.parts
          .map((ring) => ring.map(([x, y]) => toFixed(x, y, l.extent)))
          .filter((ring) => ring.length >= 4);
        if (rings.length === 0) continue;
        // Seam duplicates: the same ring can appear in two neighbouring tiles.
        const key = `${kind}|${rings[0][0]}|${rings[0][1]}|${rings[0].length}|${rings.length}`;
        if (polygonKeys.has(key)) continue;
        polygonKeys.add(key);
        const attrs = layerName === "building" ? buildingAttrs(f.tags) : {};
        polygons.push({ kind, rings, height: attrs.height ?? 0, minHeight: attrs.minHeight ?? 0, colour: attrs.colour ?? 0 });
        counts.polygons[kind] = (counts.polygons[kind] || 0) + 1;
      }
    }

    // Names. Each name is kept only if its anchor lies inside this tile.
    const named = (layerName, types) => {
      const l = byName[layerName];
      if (!l) return [];
      return l.features.filter((f) => types.includes(f.type) && f.tags.name).map((f) => ({ f, extent: l.extent }));
    };

    for (const { f, extent } of named("place", [1])) {
      const a = anchorPoint(f.parts);
      if (!a || !insideTile(a[0], a[1], extent)) continue;
      addLabel(LABEL_KIND.place, PLACE_CATEGORY[f.tags.class] ?? 0, toFixed(a[0], a[1], extent), f.tags.name);
    }
    for (const { f, extent } of named("transportation_name", [2])) {
      const a = anchorPoint(f.parts);
      if (!a || !insideTile(a[0], a[1], extent)) continue;
      const category = ROAD_CLASS[f.tags.class] ?? (f.tags.class === "path" ? 9 : 0);
      addLabel(LABEL_KIND.road, category, toFixed(a[0], a[1], extent), f.tags.name);
    }
    for (const { f, extent } of named("water_name", [1, 2])) {
      const a = anchorPoint(f.parts);
      if (!a || !insideTile(a[0], a[1], extent)) continue;
      addLabel(LABEL_KIND.water, f.tags.class === "bay" ? 2 : 1, toFixed(a[0], a[1], extent), f.tags.name);
    }
    for (const { f, extent } of named("park", [3])) {
      const c = centroidPoint(f.parts);
      if (!c || !insideTile(c[0], c[1], extent)) continue;
      addLabel(LABEL_KIND.park, 0, toFixed(c[0], c[1], extent), f.tags.name);
    }
    const housenumbers = byName.housenumber;
    if (housenumbers) {
      for (const f of housenumbers.features) {
        const a = f.parts[0]?.[0];
        const text = f.tags.housenumber;
        if (!a || !text || !insideTile(a[0], a[1], housenumbers.extent)) continue;
        addLabel(LABEL_KIND.housenumber, 0, toFixed(a[0], a[1], housenumbers.extent), String(text));
      }
    }
    for (const { f, extent } of named("poi", [1])) {
      const a = f.parts[0]?.[0];
      if (!a || !insideTile(a[0], a[1], extent)) continue;
      addLabel(LABEL_KIND.poi, POI_CATEGORY[f.tags.class] ?? POI_CATEGORY.other, toFixed(a[0], a[1], extent), f.tags.name);
    }
  }

  // Fixed speed cameras from OpenStreetMap, only those inside this area.
  if (osmRoads) for (const l of speedCameraLabels(osmRoads.cameras, bbox)) addLabel(l.kind, l.category, [l.lat, l.lon], l.name);

  const bboxFixed = [toFixed7(bbox[1]), toFixed7(bbox[0]), toFixed7(bbox[3]), toFixed7(bbox[2])];
  // Roads: from OpenStreetMap when an extract is given, otherwise from the tiles. Tile roads are
  // split wherever two roads share a point, so roads that meet mid-line can be routed across.
  const repaired = osmRoads ? buildRoadGraph({ ...osmRoads, bbox }) : { ...splitAtSharedVertices(edges), restrictions: [], strings: [""] };
  const bytes = writeDmap({
    bbox: bboxFixed,
    nodes: repaired.nodes,
    edges: repaired.edges,
    lines,
    polygons,
    labels,
    strings: repaired.strings,
    restrictions: repaired.restrictions,
  });
  const outDir = join(ROOT, "data", "out");
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `${name}.dmap`);
  await writeFile(outFile, bytes);
  const size = (await stat(outFile)).size;
  const report = {
    name,
    version,
    zoom,
    bbox,
    outFile,
    bytes: size,
    nodes: repaired.nodes.length,
    routableEdges: repaired.edges.length,
    roadSource: osmRoads ? "openstreetmap" : "tiles",
    restrictions: repaired.restrictions.length,
    speedCameras: counts.labels[LABEL_KIND.speedCamera] || 0,
    lines: lines.length,
    polygons: polygons.length,
    labels: labels.length,
    dropped,
    counts,
  };
  log(JSON.stringify(report, null, 2));
  return { outFile, report };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n, def) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : def;
  };
  const cacheDir = join(ROOT, "data", "cache");
  const versions = (await readdir(cacheDir)).sort();
  const version = arg("version", versions[versions.length - 1]);
  const started = Date.now();
  await buildArea({
    name: arg("name", "london"),
    bbox: arg("bbox", "-0.55,51.28,0.30,51.70").split(",").map(Number),
    zoom: Number(arg("zoom", "14")),
    version,
  });
  console.log(`built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
