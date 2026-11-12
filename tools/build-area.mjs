// Builds one DMAP area file from cached OpenStreetMap vector tiles.
// Usage: node tools/build-area.mjs --name=london --bbox=-0.55,51.28,0.30,51.70 --zoom=14
// Output: data/out/<name>.dmap (not committed; published to static hosting later)

import { readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeTile } from "./mvt.mjs";
import { readCachedTile, tilesForBbox } from "./fetch-tiles.mjs";
import { writeDmap, toFixed7 } from "./dmap.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Road classes we route on, from OpenMapTiles transportation.class.
const ROAD_CLASS = {
  motorway: 1,
  trunk: 2,
  primary: 3,
  secondary: 4,
  tertiary: 5,
  minor: 6,
  service: 7,
  track: 8,
};

const PLACE_KIND = { city: 1, town: 2, village: 3, suburb: 4, quarter: 4, neighbourhood: 4 };
const POLYGON_LAYERS = [
  { layer: "water", kind: 1 },
  { layer: "building", kind: 2 },
  { layer: "park", kind: 3 },
];

const SNAP_TOLERANCE = 200; // in 1e-7 degree units: about 2 m

// Tile-space point to lon/lat in degrees.
function tileToLonLat(z, tx, ty, px, py, extent) {
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

// Split a line into runs of points inside the tile. Each run also keeps the
// neighbouring point just outside the tile, so roads join across tile seams.
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

export async function buildArea({ name, bbox, zoom, version, log = console.log }) {
  const cacheRoot = join(ROOT, "data", "cache", version);
  const tiles = tilesForBbox(bbox, zoom);
  const nodes = new NodeIndex();
  const edges = [];
  const polygons = [];
  const labels = [];
  const labelKeys = new Set();
  const stats = {
    tiles: tiles.length,
    tilesWithData: 0,
    edgesByClass: {},
    oneway: 0,
    twoway: 0,
    dropped: 0,
    polygons: 0,
    labels: 0,
    oneWayValues: {},
  };

  for (const t of tiles) {
    const buf = await readCachedTile(cacheRoot, t.z, t.x, t.y);
    if (!buf || buf.length === 0) continue;
    stats.tilesWithData++;
    const layers = decodeTile(buf);
    const byName = Object.fromEntries(layers.map((l) => [l.name, l]));

    // Roads
    const transport = byName.transportation;
    if (transport) {
      for (const f of transport.features) {
        if (f.type !== 2) continue; // lines only
        const roadClass = ROAD_CLASS[f.tags.class];
        if (!roadClass) continue;
        const extent = transport.extent;

        let flags = 0;
        const brunnel = f.tags.brunnel;
        if (brunnel === "bridge") flags |= 2;
        if (brunnel === "tunnel") flags |= 4;
        if (f.tags.toll) flags |= 8;
        if (f.tags.access === "no" || f.tags.access === "private") flags |= 16;

        const ow = f.tags.oneway;
        stats.oneWayValues[String(ow)] = (stats.oneWayValues[String(ow)] || 0) + 1;
        let reverse = false;
        if (ow === 1 || ow === -1) {
          flags |= 1;
          reverse = ow === -1;
          stats.oneway++;
        } else {
          stats.twoway++;
        }

        for (const part of f.parts) {
          for (const run of ownedRuns(part, extent)) {
            const ordered = reverse ? run.slice().reverse() : run;
            const points = ordered.map(([x, y]) => tileToLonLat(t.z, t.x, t.y, x, y, extent));
            const from = nodes.get(points[0]);
            const to = nodes.get(points[points.length - 1]);
            if (from === to && points.length < 3) {
              stats.dropped++;
              continue;
            }
            edges.push({ from, to, roadClass, flags, points });
            stats.edgesByClass[f.tags.class] = (stats.edgesByClass[f.tags.class] || 0) + 1;
          }
        }
      }
    }

    // Areas
    for (const { layer, kind } of POLYGON_LAYERS) {
      const l = byName[layer];
      if (!l) continue;
      for (const f of l.features) {
        if (f.type !== 3) continue;
        const inside = f.parts.some((ring) => ring.some(([x, y]) => insideTile(x, y, l.extent)));
        if (!inside) continue;
        const rings = f.parts
          .map((ring) => ring.map(([x, y]) => tileToLonLat(t.z, t.x, t.y, x, y, l.extent)))
          .filter((ring) => ring.length >= 4);
        if (rings.length === 0) continue;
        polygons.push({ kind, rings });
        stats.polygons++;
      }
    }

    // Place names
    const places = byName.place;
    if (places) {
      for (const f of places.features) {
        if (f.type !== 1 || !f.tags.name) continue;
        const kind = PLACE_KIND[f.tags.class] || 5;
        const [px, py] = f.parts[0]?.[0] ?? [];
        if (px === undefined || !insideTile(px, py, places.extent)) continue;
        const [lat, lon] = tileToLonLat(t.z, t.x, t.y, px, py, places.extent);
        const key = `${f.tags.name}|${lat}|${lon}`;
        if (labelKeys.has(key)) continue;
        labelKeys.add(key);
        labels.push({ kind, lat, lon, name: f.tags.name });
        stats.labels++;
      }
    }
  }

  const bboxFixed = [toFixed7(bbox[1]), toFixed7(bbox[0]), toFixed7(bbox[3]), toFixed7(bbox[2])];
  const bytes = writeDmap({ bbox: bboxFixed, nodes: nodes.nodes, edges, polygons, labels });
  const outDir = join(ROOT, "data", "out");
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `${name}.dmap`);
  await writeFile(outFile, bytes);
  const size = (await stat(outFile)).size;
  const report = { name, version, zoom, bbox, outFile, bytes: size, nodes: nodes.nodes.length, edges: edges.length, polygons: polygons.length, labels: labels.length, ...stats };
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
