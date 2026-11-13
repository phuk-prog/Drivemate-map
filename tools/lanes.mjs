// Lane guidance data: reads OpenStreetMap lane tags (turn:lanes) from the Overpass API
// and attaches them to the routable roads in a map area, by location. Our own code.
//
// The lane tag is stored as the raw OSM text, one string per edge, for the direction
// the edge is travelled in. For example "left|through|through|right".
//
// Rules:
//   - turn:lanes:forward (or turn:lanes) applies to an edge that runs the same way as the way.
//   - turn:lanes:backward applies to an edge that runs against the way, on a two-way road.
//   - A one-way road that runs against the way is skipped, because its lane order would
//     need reversing. These are counted in the stats.
//
// Coordinates are [lat, lon] in 1e-7 degree units, the same as the rest of the map.

import { toFixed7 } from "./dmap.mjs";

const MAX_DISTANCE = 800; // a road matches a lane way within about 9 m
const MIN_PARALLEL_COS = Math.cos((40 * Math.PI) / 180); // direction must agree within 40 degrees
const CELL = 5000; // grid cell in 1e-7 degree units (about 55 m)

// Turns Overpass output (ways with `out geom`) into lane way records.
export function parseLaneOverpass(json) {
  const ways = [];
  let skipped = 0;
  for (const el of json.elements || []) {
    if (el.type !== "way" || !el.tags || !el.geometry) {
      skipped++;
      continue;
    }
    const t = el.tags;
    const tags = {};
    for (const k of ["turn:lanes", "turn:lanes:forward", "turn:lanes:backward"]) {
      if (typeof t[k] === "string" && t[k].length > 0) tags[k] = t[k];
    }
    if (Object.keys(tags).length === 0) {
      skipped++;
      continue;
    }
    const geom = el.geometry.map((p) => [toFixed7(p.lat), toFixed7(p.lon)]);
    if (geom.length < 2) {
      skipped++;
      continue;
    }
    ways.push({ tags, oneway: t.oneway ?? "", geom });
  }
  return { ways, skipped };
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

// The lane text for an edge, given whether it runs the same way as the way.
function laneTextFor(way, aligned) {
  if (aligned) return way.tags["turn:lanes:forward"] ?? way.tags["turn:lanes"] ?? null;
  const twoWay = way.oneway === "" || way.oneway === "no";
  return twoWay ? way.tags["turn:lanes:backward"] ?? null : null;
}

// Matches lane ways to edges. Returns { lanes: [{ edge, text }], stats }.
export function matchLanes(edges, ways) {
  // Grid of way segments, by the cells each segment's box covers.
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

  const lanes = [];
  const stats = { matched: 0, noWay: 0, oneWayAgainstWay: 0, noTagForDirection: 0 };
  edges.forEach((e, ei) => {
    const pts = e.points;
    const m = Math.floor(pts.length / 2);
    const mid = pts[m];
    // Direction of the edge at its middle.
    const before = pts[Math.max(0, m - 1)];
    const after = pts[Math.min(pts.length - 1, m + 1)];
    const dx = after[0] - before[0];
    const dy = after[1] - before[1];
    const ci = Math.floor(mid[0] / CELL);
    const cj = Math.floor(mid[1] / CELL);

    let best = null;
    let bestD = Infinity;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const id of grid.get(`${ci + di},${cj + dj}`) || []) {
          const w = ways[segWay[id]];
          const i = segStart[id];
          const a = w.geom[i];
          const b = w.geom[i + 1];
          const d = distanceSquared(mid, a, b);
          if (d > MAX_DISTANCE * MAX_DISTANCE || d >= bestD) continue;
          // Direction of the way segment, compared with the edge direction.
          const sx = b[0] - a[0];
          const sy = b[1] - a[1];
          const denom = Math.hypot(dx, dy) * Math.hypot(sx, sy);
          if (denom === 0) continue;
          const cos = (dx * sx + dy * sy) / denom;
          if (Math.abs(cos) < MIN_PARALLEL_COS) continue;
          bestD = d;
          best = { way: w, aligned: cos > 0 };
        }
      }
    }

    if (!best) {
      stats.noWay++;
      return;
    }
    const text = laneTextFor(best.way, best.aligned);
    if (text) {
      lanes.push({ edge: ei, text });
      stats.matched++;
    } else if (!best.aligned && best.way.oneway !== "" && best.way.oneway !== "no") {
      stats.oneWayAgainstWay++;
    } else {
      stats.noTagForDirection++;
    }
  });
  return { lanes, stats };
}
