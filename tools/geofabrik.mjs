// Geofabrik's extract index: download links, parents and boundaries of every extract.
// Links are looked up by extract id (for example "greater-manchester"), so they stay right if
// Geofabrik moves files. Our own code.
import { readFile } from "node:fs/promises";

export const INDEX_NOGEOM = "https://download.geofabrik.de/index-v1-nogeom.json";
export const INDEX_GEOM = "https://download.geofabrik.de/index-v1.json";

const loaded = new Map();

// Waits before the 2nd, 3rd and 4th attempt (ms). GEOFABRIK_RETRY_DELAYS ("5000,15000,45000")
// overrides them.
export const RETRY_DELAYS_MS = (process.env.GEOFABRIK_RETRY_DELAYS || "5000,15000,45000").split(",").map(Number);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch, tried again on network errors and on HTTP 5xx and 429: up to delays.length + 1
// attempts, waiting delays[i] before each retry. consume(res), if given, reads the body inside
// the same attempt (for example streaming it to a file), so a connection that fails part way
// is tried again too; its result is returned. Other HTTP errors fail at once. Each retry is
// logged with the label, the host and the reason (never headers or tokens).
export async function fetchWithRetry(url, options = {}, { fetchFn = fetch, delays = RETRY_DELAYS_MS, log = console.log, label = "download", consume = null } = {}) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "?";
    }
  })();
  for (let attempt = 1; ; attempt++) {
    let reason;
    try {
      const res = await fetchFn(url, options);
      if (res.status >= 500 || res.status === 429) {
        reason = `HTTP ${res.status}`;
        await res.body?.cancel?.().catch(() => {});
      } else if (!res.ok && options.method !== "HEAD") {
        throw Object.assign(new Error(`${label}: HTTP ${res.status}`), { final: true });
      } else {
        return consume && res.ok ? await consume(res) : res; // a failed HEAD is returned as it is
      }
    } catch (err) {
      if (err.final) throw err;
      reason = [err.message, err.cause?.code ?? err.cause?.message].filter(Boolean).join(": ");
    }
    if (attempt > delays.length) throw new Error(`${label}: failed after ${attempt} attempts (${reason})`);
    const wait = delays[attempt - 1];
    log(`${label}: attempt ${attempt} failed (${reason}, ${host}); retrying in ${Math.round(wait / 1000)} s`);
    await sleep(wait);
  }
}

// The index as GeoJSON ({ features: [{ properties: { id, parent, name, urls: { pbf } }, geometry }] }).
// source: a URL or a local file path. GEOFABRIK_INDEX overrides it (tests use a local fixture).
// Each source is read once per process.
export function fetchIndex({ geometry = false, source } = {}) {
  const from = process.env.GEOFABRIK_INDEX || source || (geometry ? INDEX_GEOM : INDEX_NOGEOM);
  if (!loaded.has(from)) {
    loaded.set(from, (async () => {
      if (!/^https?:/.test(from)) return JSON.parse(await readFile(from, "utf8"));
      return fetchWithRetry(from, {}, { label: "Geofabrik index", consume: (res) => res.json() });
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
