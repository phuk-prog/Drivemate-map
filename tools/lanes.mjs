// Lane guidance data: reads OpenStreetMap lane tags (turn:lanes) from the Overpass API
// and attaches them to the routable roads in a map area, by location. Our own code.
//
// The lane tag is stored as the raw OSM text, one string per edge, for the direction
// the edge is travelled in. For example "left|through|through|right".
//
// Rules:
//   - turn:lanes:forward (or turn:lanes) applies to an edge that runs the same way as the way.
//   - turn:lanes:backward applies to an edge that runs against the way, on a two-way road.
//   - A one-way road with oneway=-1 runs against the way: turn:lanes:backward is used as it
//     stands; plain turn:lanes (listed in the way's direction) is reversed and mirrored.
//   - An edge that runs against a oneway=yes way is a different road: it is not matched.
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

const MIRROR = {
  left: "right", right: "left",
  slight_left: "slight_right", slight_right: "slight_left",
  sharp_left: "sharp_right", sharp_right: "sharp_left",
  merge_to_left: "merge_to_right", merge_to_right: "merge_to_left",
  through: "through", reverse: "reverse", none: "none", "": "",
};

// Turns lane text written in the way's direction into text in the opposite direction, left to
// right as the driver sees it: lane order reversed, left and right values swapped, and the
// values inside one lane (separated by ";") reversed too. Returns null for any value we do not
// know, so unknown text is never attached.
export function reverseLaneText(text) {
  const lanes = text.split("|");
  const out = [];
  for (const lane of lanes) {
    const vals = lane.split(";").map((v) => v.trim());
    const mirrored = [];
    for (const v of vals) {
      if (!Object.hasOwn(MIRROR, v)) return null;
      mirrored.push(MIRROR[v]);
    }
    out.push(mirrored.reverse().join(";"));
  }
  return out.reverse().join("|");
}

// Wiki reading (Key:turn, Key:oneway): on a oneway=-1 way the :backward key lists lanes in the
// direction of travel, so it is used as it stands. Plain turn:lanes lists lanes in the direction
// of the way, so it is reversed and mirrored. :forward on such a way is the direction nobody
// travels and is ignored. Set false to leave plain turn:lanes on oneway=-1 ways unmatched.
export const REVERSE_PLAIN_ON_ONEWAY_MINUS_ONE = true;

const isOnewayYes = (o) => o === "yes" || o === "true" || o === "1";
const isOnewayMinus = (o) => o === "-1" || o === "reverse";
const isTwoWay = (o) => !isOnewayYes(o) && !isOnewayMinus(o);

// The lane text for an edge, given whether it runs the same way as the way.
// Returns { text, why }: why says what is missing when there is no text.
function laneTextFor(way, aligned) {
  const t = way.tags;
  const o = way.oneway;
  if (isOnewayMinus(o)) {
    if (aligned) return { text: null, why: "oneWayAgainstWay" }; // edge should be anti-parallel
    if (t["turn:lanes:backward"]) return { text: t["turn:lanes:backward"], why: "" };
    if (t["turn:lanes"] && REVERSE_PLAIN_ON_ONEWAY_MINUS_ONE) {
      const r = reverseLaneText(t["turn:lanes"]);
      return r ? { text: r, why: "" } : { text: null, why: "oneWayAgainstWay" };
    }
    return { text: null, why: "oneWayAgainstWay" };
  }
  if (aligned) {
    const text = t["turn:lanes:forward"] ?? t["turn:lanes"] ?? null;
    return { text, why: text ? "" : "onlyBackwardTag" };
  }
  if (isTwoWay(o)) {
    const text = t["turn:lanes:backward"] ?? null;
    return { text, why: text ? "" : "reversedEdgeOnlyForwardTag" };
  }
  return { text: null, why: "oneWayAgainstWay" };
}

// Matches lane ways to edges. Returns { lanes: [{ edge, text }], stats }, and with
// opts.details also details[edge] = { way, dist, cos, second } for every edge that found a way.
// A candidate way must run in a direction its oneway tag allows (an edge against a oneway=yes
// way belongs to another carriageway); of several candidates the best by distance and angle wins.
export function matchLanes(edges, ways, opts = {}) {
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
  const details = opts.details ? new Array(edges.length).fill(null) : null;
  const stats = {
    matched: 0,
    noWay: 0,
    oneWayAgainstWay: 0,
    noTagForDirection: 0,
    reversedEdgeOnlyForwardTag: 0,
    onlyBackwardTag: 0,
    reversedOnOneWayMinusOne: 0,
    twoWayMatchedAmbiguous: 0,
  };
  edges.forEach((e, ei) => {
    const pts = e.points;
    const m = Math.floor(pts.length / 2);
    const mid = pts[m];
    // Direction of the edge at its middle.
    const before = pts[Math.max(0, m - 1)];
    const after = pts[Math.min(pts.length - 1, m + 1)];
    // Longitude units are shorter than latitude units away from the equator: scale them so
    // distances and angles are true.
    const k = Math.cos((mid[0] * 1e-7 * Math.PI) / 180);
    const dx = after[0] - before[0];
    const dy = (after[1] - before[1]) * k;
    const ci = Math.floor(mid[0] / CELL);
    const cj = Math.floor(mid[1] / CELL);
    const edgeOneway = e.flags === undefined ? true : (e.flags & 1) === 1;

    // Best segment per way, scored by distance and angle together.
    const perWay = new Map();
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const id of grid.get(`${ci + di},${cj + dj}`) || []) {
          const wi = segWay[id];
          const w = ways[wi];
          const i = segStart[id];
          const a = w.geom[i];
          const b = w.geom[i + 1];
          const d2 = distanceSquared([mid[0], mid[1] * k], [a[0], a[1] * k], [b[0], b[1] * k]);
          if (d2 > MAX_DISTANCE * MAX_DISTANCE) continue;
          const sx = b[0] - a[0];
          const sy = (b[1] - a[1]) * k;
          const denom = Math.hypot(dx, dy) * Math.hypot(sx, sy);
          if (denom === 0) continue;
          const cos = (dx * sx + dy * sy) / denom;
          if (Math.abs(cos) < MIN_PARALLEL_COS) continue;
          const aligned = cos > 0;
          // Direction the oneway tag allows.
          if (isOnewayYes(w.oneway) && !aligned) continue;
          if (isOnewayMinus(w.oneway) && (aligned || !edgeOneway)) continue;
          const dist = Math.sqrt(d2);
          const score = dist + 400 * (1 - Math.abs(cos));
          const prev = perWay.get(wi);
          if (!prev || score < prev.score) perWay.set(wi, { wi, way: w, aligned, dist, cos, score });
        }
      }
    }
    const cands = [...perWay.values()].sort((x, y) => x.score - y.score);

    if (cands.length === 0) {
      stats.noWay++;
      return;
    }
    const best = cands[0];
    if (details) details[ei] = { way: best.wi, dist: best.dist, cos: best.cos, second: cands[1] ? { way: cands[1].wi, dist: cands[1].dist, cos: cands[1].cos } : null };
    // Two candidate ways that both give a text but different ones, with nearly equal scores:
    // we cannot tell which road this is, so leave it unmatched.
    if (cands[1] && cands[1].score - best.score < 150) {
      const t0 = laneTextFor(best.way, best.aligned).text;
      const t1 = laneTextFor(cands[1].way, cands[1].aligned).text;
      if (t0 && t1 && t0 !== t1) {
        stats.twoWayMatchedAmbiguous++;
        return;
      }
    }
    const { text, why } = laneTextFor(best.way, best.aligned);
    if (text) {
      lanes.push({ edge: ei, text });
      stats.matched++;
      if (isOnewayMinus(best.way.oneway)) stats.reversedOnOneWayMinusOne++;
    } else if (why === "oneWayAgainstWay") {
      stats.oneWayAgainstWay++;
    } else {
      stats.noTagForDirection++;
      if (why) stats[why]++;
    }
  });
  return { lanes, stats, details };
}
