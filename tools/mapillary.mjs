// Mapillary client: speed-limit sign detections (map features) for a bounding box.
// Uses the Mapillary Graph API v4 map_features endpoint. Large boxes return HTTP 500, so a box is
// split into small tiles (about 0.01 x 0.01 degrees), each tile's paging.next links are followed,
// failed requests are retried with back-off, and there is a polite delay between requests.
// The token is read by the caller (normally from MAPILLARY_TOKEN) and is never printed: every URL
// that may appear in a message goes through redact().
// Our own code. No third-party dependencies.

export const API = "https://graph.mapillary.com/map_features";
export const FIELDS = "id,object_value,geometry,first_seen_at,last_seen_at";
export const TILE_DEG = 0.01;
export const MIN_TILE_DEG = 0.0025; // a tile that keeps returning HTTP 500 is split down to this size
export const PAGE_LIMIT = 1000;
export const MAX_PAGES = 50;
export const DELAY_MS = 250;
export const RETRIES = 4;

// Speed-limit sign object values, for example "regulatory--maximum-speed-limit-30--g1".
// "end-of-maximum-speed-limit" and other signs do not match.
const SIGN_RE = /^regulatory--maximum-speed-limit-(\d{1,3})--g\d+$/;

// Values asked for in the server-side filter: every common limit in km/h and mph, sign variants g1 to g5.
export const SIGN_LIMITS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 90, 100, 110, 120, 130];
export const SIGN_GROUPS = [1, 2, 3, 4, 5];
export function speedSignObjectValues(limits = SIGN_LIMITS, groups = SIGN_GROUPS) {
  const out = [];
  for (const n of limits) for (const g of groups) out.push(`regulatory--maximum-speed-limit-${n}--g${g}`);
  return out;
}

export const KMH_PER_MPH = 1.609344;

// Areas whose signs are in mph: Great Britain, Northern Ireland, the Isle of Man and the Channel
// Islands. Rough boxes ([minLat, minLon, maxLat, maxLon]) that keep out the Republic of Ireland's
// east coast (km/h); the Northern Ireland box takes in a little of the Republic's border counties.
const MPH_BOXES = [
  [49.8, -6.5, 50.5, 1.8], // Scilly, Cornwall, south coast
  [50.5, -5.8, 54.6, 1.8], // England, Wales, Isle of Man (Wicklow Head, Ireland, is at -5.996)
  [54.6, -6.2, 55.5, 1.8], // southern Scotland, northern England, County Antrim coast
  [55.5, -8.7, 61.0, 1.8], // Scotland with the Hebrides, Orkney and Shetland
  [54.0, -8.2, 55.35, -5.4], // Northern Ireland
  [49.15, -2.7, 49.75, -2.0], // Channel Islands
];

export function signUnit(lat, lon) {
  for (const [a, b, c, d] of MPH_BOXES) if (lat >= a && lat <= c && lon >= b && lon <= d) return "mph";
  return "km/h";
}

// { value, unit, kmh, mph } for a speed-limit object value at a place, or null for any other sign.
// kmh is exact (not rounded); mph is null where signs are in km/h.
export function parseSpeedSign(objectValue, lat, lon, unit = signUnit(lat, lon)) {
  const m = SIGN_RE.exec(String(objectValue ?? ""));
  if (!m) return null;
  const value = Number(m[1]);
  if (value < 5 || value > 150) return null;
  return unit === "mph" ? { value, unit, kmh: value * KMH_PER_MPH, mph: value } : { value, unit, kmh: value, mph: null };
}

// Tiles covering a box given as [minLon, minLat, maxLon, maxLat] (Mapillary's order), each about
// tileDeg on a side. Tile edges are rounded to 7 decimals so neighbouring tiles share exact edges.
export function tileBbox([minLon, minLat, maxLon, maxLat], tileDeg = TILE_DEG) {
  const r = (v) => Math.round(v * 1e7) / 1e7;
  const nx = Math.max(1, Math.ceil((maxLon - minLon) / tileDeg - 1e-9));
  const ny = Math.max(1, Math.ceil((maxLat - minLat) / tileDeg - 1e-9));
  const tiles = [];
  for (let j = 0; j < ny; j++) {
    const a = r(minLat + j * tileDeg);
    const c = j === ny - 1 ? r(maxLat) : r(minLat + (j + 1) * tileDeg);
    for (let i = 0; i < nx; i++) {
      const b = r(minLon + i * tileDeg);
      const d = i === nx - 1 ? r(maxLon) : r(minLon + (i + 1) * tileDeg);
      tiles.push([b, a, d, c]);
    }
  }
  return tiles;
}

export function redact(text) {
  return String(text).replace(/(access_token=)[^&\s"']+/gi, "$1***").replace(/(MLY\|)[^&\s"']+/g, "$1***");
}

export function featuresUrl(bbox, token, { objectValues = speedSignObjectValues(), limit = PAGE_LIMIT } = {}) {
  const p = new URLSearchParams();
  p.set("access_token", token);
  p.set("fields", FIELDS);
  p.set("bbox", bbox.join(","));
  if (objectValues && objectValues.length) p.set("object_values", objectValues.join(","));
  p.set("limit", String(limit));
  return `${API}?${p.toString()}`;
}

// paging.next may or may not carry the token; make sure it does.
function withToken(url, token) {
  const u = new URL(url);
  if (!u.searchParams.get("access_token")) u.searchParams.set("access_token", token);
  return u.toString();
}

export class MapillaryError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One GET with retries. Retries network errors, HTTP 429 and HTTP 5xx with back-off
// (2 s, 4 s, 8 s, 16 s). Other HTTP errors (bad or expired token) fail at once.
async function getJson(url, ctx) {
  for (let attempt = 0; ; attempt++) {
    if (ctx.requests > 0 && ctx.delayMs > 0) await ctx.sleep(ctx.delayMs);
    ctx.requests++;
    let status = 0;
    let detail = "";
    try {
      const res = await ctx.fetch(url, { headers: { accept: "application/json" } });
      status = res.status;
      if (res.ok) return await res.json();
      detail = redact((await res.text().catch(() => "")).slice(0, 200));
    } catch (err) {
      detail = redact(err?.message ?? err);
    }
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable) throw new MapillaryError(`Mapillary HTTP ${status}: ${detail || "no detail"}`, status);
    if (attempt >= ctx.retries) throw new MapillaryError(`Mapillary request failed after ${attempt + 1} tries (HTTP ${status || "network error"}): ${detail}`, status);
    await ctx.sleep(2000 * 2 ** attempt);
  }
}

// All map features in one tile, following paging.next. A tile that still fails with HTTP 500 after
// retries is split into four smaller tiles (down to MIN_TILE_DEG).
async function fetchTile(bbox, ctx, out) {
  let url = featuresUrl(bbox, ctx.token, ctx);
  try {
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body = await getJson(url, ctx);
      for (const f of body?.data ?? []) out.push(f);
      const next = body?.paging?.next;
      url = next && (body?.data ?? []).length ? withToken(next, ctx.token) : null;
    }
  } catch (err) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const size = Math.max(maxLon - minLon, maxLat - minLat);
    if (err instanceof MapillaryError && err.status >= 500 && size / 2 >= ctx.minTileDeg - 1e-12) {
      ctx.log(`  tile ${bbox.join(",")} keeps failing; splitting it`);
      for (const t of tileBbox(bbox, size / 2)) await fetchTile(t, ctx, out);
      return;
    }
    throw err;
  }
}

// Speed-limit signs in a box [minLon, minLat, maxLon, maxLat].
// Returns [{ id, objectValue, lat, lon, value, unit, kmh, mph, firstSeenAt, lastSeenAt }], each sign
// once, sorted by id. Only signs whose point lies in the box (west and south edges included, east and
// north edges excluded, so neighbouring boxes never share a sign) are returned.
// Options: token (required), fetch, sleep, delayMs, retries, tileDeg, minTileDeg, objectValues
// (null for no server-side filter), limit, unitFor(lat, lon), log.
export async function fetchSpeedSigns(bbox, opts = {}) {
  if (!opts.token) throw new Error("fetchSpeedSigns: no Mapillary token");
  const ctx = {
    token: opts.token,
    fetch: opts.fetch ?? globalThis.fetch,
    sleep: opts.sleep ?? defaultSleep,
    delayMs: opts.delayMs ?? DELAY_MS,
    retries: opts.retries ?? RETRIES,
    minTileDeg: opts.minTileDeg ?? MIN_TILE_DEG,
    objectValues: opts.objectValues === undefined ? speedSignObjectValues() : opts.objectValues,
    limit: opts.limit ?? PAGE_LIMIT,
    log: opts.log ?? (() => {}),
    requests: opts.requestsSoFar ?? 0,
  };
  const raw = [];
  for (const tile of tileBbox(bbox, opts.tileDeg ?? TILE_DEG)) await fetchTile(tile, ctx, raw);
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const byId = new Map();
  for (const f of raw) {
    const c = f?.geometry?.type === "Point" ? f.geometry.coordinates : null;
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const [lon, lat] = c;
    if (lon < minLon || lon >= maxLon || lat < minLat || lat >= maxLat) continue;
    const unit = opts.unitFor ? opts.unitFor(lat, lon) : signUnit(lat, lon);
    const sign = parseSpeedSign(f.object_value, lat, lon, unit);
    if (!sign || f.id == null) continue;
    const id = String(f.id);
    if (!byId.has(id)) byId.set(id, { id, objectValue: f.object_value, lat, lon, ...sign, firstSeenAt: f.first_seen_at ?? null, lastSeenAt: f.last_seen_at ?? null });
  }
  const signs = [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
  signs.requests = ctx.requests;
  return signs;
}

// Mapillary ids are long decimal strings: compare by length, then text.
export function compareIds(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
