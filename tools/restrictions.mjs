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
// If no node at the via point fits, nodes up to this far away (metres) are tried, with a tighter angle limit.
const NEAR_RADIUS = 15;
const NEAR_ANGLE = Math.PI / 4;
// Two nearby nodes that fit equally well mean the match is unclear (radians of total angle difference).
const AMBIGUOUS_MARGIN = Math.PI / 6;
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

// Metres per 1e-7 degree of latitude.
const M_PER_UNIT = 0.0111;

// Grid index over nodes, for finding the node nearest a point and the nodes around it.
function buildNodeGrid(nodes) {
  const grid = new Map();
  nodes.forEach((n, i) => {
    const key = `${Math.floor(n.lat / CELL)},${Math.floor(n.lon / CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });
  // Nodes within `radius` metres of the point (true distance, longitude scaled), nearest first.
  const within = (lat, lon, radius, k) => {
    const ci = Math.floor(lat / CELL);
    const cj = Math.floor(lon / CELL);
    const found = [];
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const i of grid.get(`${ci + di},${cj + dj}`) || []) {
          const d = Math.hypot((nodes[i].lat - lat) * M_PER_UNIT, (nodes[i].lon - lon) * M_PER_UNIT * k);
          if (d <= radius) found.push([d, i]);
        }
      }
    }
    return found.sort((x, y) => x[0] - y[0]).map((f) => f[1]);
  };
  // The node nearest the point, within VIA_TOLERANCE in each axis (as before), or -1.
  const nearest = (lat, lon) => {
    let best = -1;
    let bestD = Infinity;
    for (const i of within(lat, lon, 20, 1)) {
      const dl = nodes[i].lat - lat;
      const dn = nodes[i].lon - lon;
      if (Math.abs(dl) > VIA_TOLERANCE || Math.abs(dn) > VIA_TOLERANCE) continue;
      const d = dl * dl + dn * dn;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  return { nearest, within };
}

// Direction vector from a to b in true metres (longitude scaled by k = cos(latitude)).
const vec = (a, b, k) => [(b[0] - a[0]) * M_PER_UNIT, (b[1] - a[1]) * M_PER_UNIT * k];

// Angle between two vectors, in radians (0 to pi). A zero-length vector gives pi (no direction).
function angleBetween(u, w) {
  const lu = Math.hypot(u[0], u[1]);
  const lw = Math.hypot(w[0], w[1]);
  if (lu === 0 || lw === 0) return Math.PI;
  return Math.abs(Math.atan2(u[0] * w[1] - u[1] * w[0], u[0] * w[0] + u[1] * w[1]));
}

// The point next to the one at `index` on a line, on the side that is not the end.
// Used to get the direction a way takes at the via node.
function neighbourOf(pts, index) {
  if (index === 0) return pts[1];
  if (index === pts.length - 1) return pts[pts.length - 2];
  return pts[index - 1];
}

// The point of an edge that gives its direction at node v: the first point at least MIN_ARM metres
// from v along the edge (a point right next to v, or a repeated point, gives a noisy direction).
const MIN_ARM = 3;
function armPoint(pts, atEnd, node, k) {
  const n = pts.length;
  for (let s = 1; s < n; s++) {
    const p = atEnd ? pts[n - 1 - s] : pts[s];
    if (Math.hypot((p[0] - node.lat) * M_PER_UNIT, (p[1] - node.lon) * M_PER_UNIT * k) >= MIN_ARM) return p;
  }
  return atEnd ? pts[0] : pts[n - 1];
}

// True when a record's from way and to way are the same OSM way: a U-turn on that road. The records
// carry no OSM IDs, so their points are compared, in any order.
function isSameWay(r) {
  if (r.from.length !== r.to.length) return false;
  const key = (pts) => pts.map((p) => `${p[0]},${p[1]}`).sort().join("|");
  return key(r.from) === key(r.to);
}

// Matches restriction records to edges. nodes and edges are the final, split graph.
// Returns { matched: [{ kind, from, via, to }], unmatched: { noVia, noFrom, noTo }, failed, duplicates, uTurns }.
export function matchRestrictions(nodes, edges, records) {
  const { nearest, within } = buildNodeGrid(nodes);
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
  const seen = new Set();
  let duplicates = 0; // records that matched the same turn as an earlier one
  let uTurns = 0; // records whose from way and to way are the same way; not matched, not unmatched
  const failed = []; // { record, reason } for each unmatched record, for diagnostics

  // The edge at node v whose direction best fits `refDir` (the OSM way's direction at the OSM via point).
  const pick = (v, refDir, isArriving, exclude, k, limit) => {
    const node = nodes[v];
    let best = -1;
    let bestAngle = Infinity;
    for (const ei of touching[v]) {
      if (ei === exclude) continue;
      const e = edges[ei];
      if (isArriving ? !arrives(e, v) : !departs(e, v)) continue;
      // Which end of the edge touches v: the end if it arrives there (e.to), else the start.
      const atEnd = isArriving ? e.to === v : e.to === v && e.from !== v;
      const nb = armPoint(e.points, atEnd, node, k);
      const a = angleBetween(refDir, vec([node.lat, node.lon], nb, k));
      if (a < bestAngle) {
        bestAngle = a;
        best = ei;
      }
    }
    return bestAngle <= limit ? { edge: best, angle: bestAngle } : null;
  };

  // Tries to match one record at node v. Returns { from, to, score } or { fail }.
  const attempt = (v, fromDir, toDir, k, limit) => {
    const f = pick(v, fromDir, true, -1, k, limit);
    if (!f) return { fail: "noFrom" };
    const t = pick(v, toDir, false, f.edge, k, limit);
    if (!t) return { fail: "noTo" };
    return { from: f.edge, to: t.edge, score: f.angle + t.angle };
  };

  for (const r of records) {
    // A U-turn is not a turn between two different roads. The app's router turns back along the edge it
    // arrived on only at a dead end, so these records need nothing stored. Matching them anyway can pick
    // a side road within the angle limit and store a wrong turn ban (or a wrong only-turn).
    if (isSameWay(r)) {
      uTurns++;
      continue;
    }
    const k = Math.cos((r.via[0] / 1e7) * (Math.PI / 180));
    // Directions of the OSM ways at the OSM via point: towards their points next to it.
    const fromDir = vec(r.via, neighbourOf(r.from, indexNearest(r.from, r.via)), k);
    const toDir = vec(r.via, neighbourOf(r.to, indexNearest(r.to, r.via)), k);

    // First choice: the node at the via point itself, with a generous angle limit.
    const exact = nearest(r.via[0], r.via[1]);
    let result = null;
    let failure = "noVia";
    if (exact >= 0) {
      const a = attempt(exact, fromDir, toDir, k, MAX_ANGLE);
      if (a.fail) failure = a.fail;
      else result = { v: exact, from: a.from, to: a.to };
    }

    // Second choice: tile data can split one junction into several nearby nodes, so the road ends that
    // meet the OSM via point may sit on a neighbouring node. Both roads must still meet at one node,
    // each within a tighter angle limit, and only one node may fit: an unclear case stays unmatched.
    if (!result) {
      const fits = [];
      for (const v of within(r.via[0], r.via[1], NEAR_RADIUS, k)) {
        if (v === exact) continue;
        const a = attempt(v, fromDir, toDir, k, NEAR_ANGLE);
        if (!a.fail) fits.push({ v, from: a.from, to: a.to, score: a.score });
      }
      fits.sort((x, y) => x.score - y.score);
      if (fits.length === 1 || (fits.length > 1 && fits[1].score - fits[0].score > AMBIGUOUS_MARGIN)) {
        result = fits[0];
      }
    }

    if (!result) {
      unmatched[failure]++;
      failed.push({ record: r, reason: failure });
      continue;
    }
    // Two OSM relations can describe the same turn; keep one record per kind, from edge, via node and to edge.
    const key = `${r.kind}/${result.from}/${result.to}/${result.v}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    matched.push({ kind: r.kind, from: result.from, via: result.v, to: result.to });
  }
  return { matched, unmatched, failed, duplicates, uTurns };
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
