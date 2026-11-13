// Turn restrictions: reads OpenStreetMap restriction relations (from the Overpass API)
// and matches them to the routable roads in a map area, by location rather than by
// OSM ID. Our own code. No third-party dependencies.
//
// Coordinates are [lat, lon] in 1e-7 degree units, the same as the rest of the map.

import { RESTRICTION_NO, RESTRICTION_ONLY, toFixed7 } from "./dmap.mjs";

// A via node in the map must be within this distance of the OSM via node (about 3 m).
const VIA_TOLERANCE = 300;
// Matching a road to a turn uses the direction it leaves or enters the junction.
// A road is accepted only if its direction is within this angle (radians, about 60 degrees).
const MAX_ANGLE = Math.PI / 3;
const CELL = 5000; // grid cell for finding nodes, in 1e-7 degree units (about 55 m)
const ONE_WAY = 1; // edge flag: travel is allowed only from `from` to `to`

// Turns Overpass output (relations with `out geom`) into restriction records.
// Returns { records, skipped } where skipped counts relations that cannot be used.
export function parseOverpass(json) {
  const records = [];
  let skipped = 0;
  for (const el of json.elements || []) {
    if (el.type !== "relation" || !el.tags || !el.members) {
      skipped++;
      continue;
    }
    const tag = el.tags.restriction;
    const kind = tag && tag.startsWith("only_") ? RESTRICTION_ONLY : tag && tag.startsWith("no_") ? RESTRICTION_NO : 0;
    if (!kind) {
      skipped++;
      continue;
    }
    const from = el.members.filter((m) => m.role === "from" && m.type === "way");
    const to = el.members.filter((m) => m.role === "to" && m.type === "way");
    const via = el.members.filter((m) => m.role === "via");
    // Only simple restrictions: one from way, one to way, and a single via node.
    if (from.length !== 1 || to.length !== 1 || via.length !== 1 || via[0].type !== "node") {
      skipped++;
      continue;
    }
    const fromPts = (from[0].geometry || []).map((p) => [toFixed7(p.lat), toFixed7(p.lon)]);
    const toPts = (to[0].geometry || []).map((p) => [toFixed7(p.lat), toFixed7(p.lon)]);
    if (fromPts.length < 2 || toPts.length < 2 || typeof via[0].lat !== "number") {
      skipped++;
      continue;
    }
    records.push({
      kind,
      from: fromPts,
      via: [toFixed7(via[0].lat), toFixed7(via[0].lon)],
      to: toPts,
    });
  }
  return { records, skipped };
}

// Grid index over nodes, for finding the node nearest a point.
function buildNodeGrid(nodes) {
  const grid = new Map();
  nodes.forEach((n, i) => {
    const key = `${Math.floor(n.lat / CELL)},${Math.floor(n.lon / CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });
  return (lat, lon) => {
    const ci = Math.floor(lat / CELL);
    const cj = Math.floor(lon / CELL);
    let best = -1;
    let bestD = Infinity;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const i of grid.get(`${ci + di},${cj + dj}`) || []) {
          const dl = nodes[i].lat - lat;
          const dn = nodes[i].lon - lon;
          if (Math.abs(dl) > VIA_TOLERANCE || Math.abs(dn) > VIA_TOLERANCE) continue;
          const d = dl * dl + dn * dn;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best;
  };
}

// Angle between the direction v->a and v->b, in radians (0 to pi).
function angleAt(v, a, b) {
  const ax = a[0] - v.lat;
  const ay = a[1] - v.lon;
  const bx = b[0] - v.lat;
  const by = b[1] - v.lon;
  const cross = ax * by - ay * bx;
  const dot = ax * bx + ay * by;
  return Math.abs(Math.atan2(cross, dot));
}

// The point next to the one at `index` on a line, on the side that is not the end.
// Used to get the direction a way takes at the via node.
function neighbourOf(pts, index) {
  if (index === 0) return pts[1];
  if (index === pts.length - 1) return pts[pts.length - 2];
  return pts[index - 1];
}

// Matches restriction records to edges. nodes and edges are the final, split graph.
// Returns { matched: [{ kind, from, via, to }], unmatched: { noVia, noFrom, noTo } }.
export function matchRestrictions(nodes, edges, records) {
  const findNode = buildNodeGrid(nodes);
  // For each node, the edges that touch it.
  const touching = nodes.map(() => []);
  edges.forEach((e, ei) => {
    touching[e.from].push(ei);
    if (e.to !== e.from) touching[e.to].push(ei);
  });

  // Can travel arrive at node v along edge e? Can it leave v along e?
  const arrives = (e, v) => e.to === v || (e.from === v && !(e.flags & ONE_WAY));
  const departs = (e, v) => e.from === v || (e.to === v && !(e.flags & ONE_WAY));

  const unmatched = { noVia: 0, noFrom: 0, noTo: 0 };
  const matched = [];
  const failed = []; // { record, reason } for each unmatched record, for diagnostics

  for (const r of records) {
    const v = findNode(r.via[0], r.via[1]);
    if (v < 0) {
      unmatched.noVia++;
      failed.push({ record: r, reason: "noVia" });
      continue;
    }
    const node = nodes[v];

    // The from way: the point on it next to the via node, and where it ends.
    const fromRef = neighbourOf(r.from, indexNearest(r.from, r.via));
    const toRef = neighbourOf(r.to, indexNearest(r.to, r.via));

    const pick = (candidates, ref, isArriving, exclude) => {
      let best = -1;
      let bestAngle = Infinity;
      for (const ei of candidates) {
        if (ei === exclude) continue;
        const e = edges[ei];
        if (isArriving ? !arrives(e, v) : !departs(e, v)) continue;
        const pts = e.points;
        // Along the edge, the neighbour of the node is the point next to its end at v.
        const nb = isArriving
          ? e.to === v
            ? pts[pts.length - 2]
            : pts[1]
          : e.from === v
            ? pts[1]
            : pts[pts.length - 2];
        const a = angleAt(node, ref, nb);
        if (a < bestAngle) {
          bestAngle = a;
          best = ei;
        }
      }
      return bestAngle <= MAX_ANGLE ? best : -1;
    };

    const fromEdge = pick(touching[v], fromRef, true, -1);
    if (fromEdge < 0) {
      unmatched.noFrom++;
      failed.push({ record: r, reason: "noFrom" });
      continue;
    }
    const toEdge = pick(touching[v], toRef, false, fromEdge);
    if (toEdge < 0) {
      unmatched.noTo++;
      failed.push({ record: r, reason: "noTo" });
      continue;
    }
    matched.push({ kind: r.kind, from: fromEdge, via: v, to: toEdge });
  }
  return { matched, unmatched, failed };
}

// Index of the point in pts that is nearest to the target point.
function indexNearest(pts, target) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dl = pts[i][0] - target[0];
    const dn = pts[i][1] - target[1];
    const d = dl * dl + dn * dn;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
