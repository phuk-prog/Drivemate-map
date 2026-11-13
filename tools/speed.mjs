// Road speed limits: reads OpenStreetMap `maxspeed` tags and attaches them to the routable
// roads in a map area, by location and direction. Our own code.
//
// One limit per edge is stored in the map file: the displayed number and its unit
// (0 km/h, 1 mph). Only plain numbers are used. Words such as "national", "signals", "none",
// "walk" and "variable", country defaults such as "GB:nsl_single", lists such as "30;50"
// and anything else we cannot read exactly are dropped. We never guess a default limit:
// an edge with no limit simply shows none.
//
// Cache record (made by tools/osm-extract.mjs), one per maxspeed key on a way:
//   { way, value, unit, direction: "both"|"forward"|"backward", oneway: 0|1|-1, geom: [[lat, lon], ...] }
// geom is a thinned copy of the way (at most a dozen points, always the first and last).
// Coordinates are [lat, lon] in 1e-7 degree units, the same as the rest of the map.

export const SPEED_KMH = 0;
export const SPEED_MPH = 1;

const MAX_DISTANCE = 800; // a road matches a way within about 9 m
const AMBIGUOUS_MARGIN = 200; // another way with a different limit within 2 m more: skip the edge
const MIN_PARALLEL_COS = Math.cos((40 * Math.PI) / 180); // direction must agree within 40 degrees
const CELL = 5000; // grid cell in 1e-7 degree units (about 55 m)

// Parses one OSM maxspeed value. Returns { value, unit } or null when it is not a plain limit.
export function parseMaxspeed(text) {
  if (typeof text !== "string") return null;
  const m = /^\s*(\d{1,3})\s*(km\/h|kmh|kph|mph)?\s*$/i.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  if (value < 5 || value > 200) return null; // 0 and tiny values are mistakes; nothing real is above 200
  const unit = m[2] && m[2].toLowerCase() === "mph" ? SPEED_MPH : SPEED_KMH;
  if (unit === SPEED_MPH && value > 100) return null;
  return { value, unit };
}

// OSM oneway tag to 1 (way direction), -1 (against the way direction) or 0 (two-way).
export function parseOneway(text) {
  if (text === "yes" || text === "true" || text === "1") return 1;
  if (text === "-1" || text === "reverse") return -1;
  return 0;
}

// Distance from point p to segment a-b, in squared units (planar; fine at this scale).
function distanceSquared(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = a[0] + t * dx - p[0];
  const ey = a[1] + t * dy - p[1];
  return ex * ex + ey * ey;
}

// The limit this way gives an edge, or null. `aligned` is whether the edge runs the way's direction.
function limitFor(way, aligned) {
  if (way.oneway !== 0) {
    // A one-way road gives a limit only to an edge that runs the permitted direction.
    const allowed = way.oneway === 1 ? aligned : !aligned;
    if (!allowed) return null;
  }
  const want = aligned ? "forward" : "backward";
  return way.limits[want] ?? way.limits.both ?? null;
}

// Matches speed ways to edges. Returns { speedLimits: [{ edge, value, unit }], stats }.
export function matchSpeedLimits(edges, speedWays) {
  // Records of one OSM way (plain, forward and backward) share a geometry: group them.
  const ways = [];
  const byId = new Map();
  for (const r of speedWays) {
    if (!r.geom || r.geom.length < 2) continue;
    let w = r.way !== undefined ? byId.get(r.way) : undefined;
    if (!w) {
      w = { geom: r.geom, oneway: r.oneway || 0, limits: {} };
      ways.push(w);
      if (r.way !== undefined) byId.set(r.way, w);
    }
    w.limits[r.direction || "both"] = { value: r.value, unit: r.unit };
  }

  const segWay = [];
  const segStart = [];
  const grid = new Map();
  ways.forEach((w, wi) => {
    for (let i = 0; i + 1 < w.geom.length; i++) {
      const a = w.geom[i];
      const b = w.geom[i + 1];
      const id = segWay.length;
      segWay.push(wi);
      segStart.push(i);
      const minI = Math.floor(Math.min(a[0], b[0]) / CELL);
      const maxI = Math.floor(Math.max(a[0], b[0]) / CELL);
      const minJ = Math.floor(Math.min(a[1], b[1]) / CELL);
      const maxJ = Math.floor(Math.max(a[1], b[1]) / CELL);
      for (let ci = minI; ci <= maxI; ci++) {
        for (let cj = minJ; cj <= maxJ; cj++) {
          const key = `${ci},${cj}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(id);
        }
      }
    }
  });

  const speedLimits = [];
  const stats = { waysUsed: ways.length, matched: 0, matchedKmh: 0, matchedMph: 0, noWay: 0, oneWayAgainstWay: 0, noTagForDirection: 0, ambiguous: 0 };
  edges.forEach((e, ei) => {
    const pts = e.points;
    const m = Math.floor(pts.length / 2);
    const mid = pts[m];
    const before = pts[Math.max(0, m - 1)];
    const after = pts[Math.min(pts.length - 1, m + 1)];
    const dx = after[0] - before[0];
    const dy = after[1] - before[1];
    const ci = Math.floor(mid[0] / CELL);
    const cj = Math.floor(mid[1] / CELL);

    // Nearest parallel way segment, and for each other way its nearest distance.
    const nearest = new Map(); // way index -> { d, aligned }
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const id of grid.get(`${ci + di},${cj + dj}`) || []) {
          const wi = segWay[id];
          const w = ways[wi];
          const i = segStart[id];
          const a = w.geom[i];
          const b = w.geom[i + 1];
          const d = distanceSquared(mid, a, b);
          if (d > MAX_DISTANCE * MAX_DISTANCE) continue;
          const prev = nearest.get(wi);
          if (prev && prev.d <= d) continue;
          const sx = b[0] - a[0];
          const sy = b[1] - a[1];
          const denom = Math.hypot(dx, dy) * Math.hypot(sx, sy);
          if (denom === 0) continue;
          const cos = (dx * sx + dy * sy) / denom;
          if (Math.abs(cos) < MIN_PARALLEL_COS) continue;
          nearest.set(wi, { d, aligned: cos > 0 });
        }
      }
    }

    if (nearest.size === 0) {
      stats.noWay++;
      return;
    }
    let bestWi = -1;
    let bestD = Infinity;
    for (const [wi, c] of nearest) {
      if (c.d < bestD) {
        bestD = c.d;
        bestWi = wi;
      }
    }
    const best = nearest.get(bestWi);
    const limit = limitFor(ways[bestWi], best.aligned);
    if (!limit) {
      if (ways[bestWi].oneway !== 0 && limitFor({ ...ways[bestWi], oneway: 0 }, best.aligned)) stats.oneWayAgainstWay++;
      else stats.noTagForDirection++;
      return;
    }
    // Another way almost as close with a different limit: we cannot tell which road this is.
    const bestDist = Math.sqrt(bestD);
    for (const [wi, c] of nearest) {
      if (wi === bestWi) continue;
      if (Math.sqrt(c.d) > bestDist + AMBIGUOUS_MARGIN) continue;
      const other = limitFor(ways[wi], c.aligned);
      if (other && (other.value !== limit.value || other.unit !== limit.unit)) {
        stats.ambiguous++;
        return;
      }
    }
    speedLimits.push({ edge: ei, value: limit.value, unit: limit.unit });
    stats.matched++;
    if (limit.unit === SPEED_MPH) stats.matchedMph++;
    else stats.matchedKmh++;
  });
  return { speedLimits, stats };
}
