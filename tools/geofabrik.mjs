// Geofabrik's extract index: download links, parents and boundaries of every extract.
// Links are looked up by extract id (for example "greater-manchester"), so they stay right if
// Geofabrik moves files. Our own code.
import { readFile } from "node:fs/promises";

export const INDEX_NOGEOM = "https://download.geofabrik.de/index-v1-nogeom.json";
export const INDEX_GEOM = "https://download.geofabrik.de/index-v1.json";

const loaded = new Map();

// The index as GeoJSON ({ features: [{ properties: { id, parent, name, urls: { pbf } }, geometry }] }).
// source: a URL or a local file path. GEOFABRIK_INDEX overrides it (tests use a local fixture).
// Each source is read once per process.
export function fetchIndex({ geometry = false, source } = {}) {
  const from = process.env.GEOFABRIK_INDEX || source || (geometry ? INDEX_GEOM : INDEX_NOGEOM);
  if (!loaded.has(from)) {
    loaded.set(from, (async () => {
      if (!/^https?:/.test(from)) return JSON.parse(await readFile(from, "utf8"));
      const res = await fetch(from);
      if (!res.ok) throw new Error(`Geofabrik index: HTTP ${res.status}`);
      return res.json();
    })());
    loaded.get(from).catch(() => loaded.delete(from));
  }
  return loaded.get(from);
}

export async function extractUrl(id) {
  const index = await fetchIndex();
  const hit = index.features.find((f) => f.properties.id === id);
  if (!hit) throw new Error(`Geofabrik has no extract with id "${id}"`);
  return hit.properties.urls.pbf;
}

// Every ring of a GeoJSON Polygon or MultiPolygon, as arrays of [lon, lat].
export function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  throw new Error(`unsupported geometry type ${geometry.type}`);
}

// Bounding box of a geometry, lon-first: [minLon, minLat, maxLon, maxLat].
export function geometryBbox(geometry) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const ring of ringsOf(geometry)) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (minLon === Infinity) throw new Error("geometry has no points");
  return [minLon, minLat, maxLon, maxLat];
}
