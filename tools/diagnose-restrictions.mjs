// Diagnoses why turn restrictions fail to match roads. Build-time only, not part of the app.
// Builds the road graph the way tools/build-area.mjs does, runs matchRestrictions, then explains each failure.
// Usage: node tools/diagnose-restrictions.mjs --name=london --bbox=-0.55,51.28,0.30,51.70 --zoom=14
// Needs data/cache/<version>/ tiles (tools/fetch-tiles.mjs) and data/osm-cache/restrictions/<name>.json (tools/osm-extract.mjs).

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeTile } from "./mvt.mjs";
import { readCachedTile, tilesForBbox } from "./fetch-tiles.mjs";
import { toFixed7 } from "./dmap.mjs";
import { splitAtSharedVertices, joinCrossings } from "./graph.mjs";
import { matchRestrictions } from "./restrictions.mjs";
import { ROAD_CLASS } from "./classes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP_TOLERANCE = 200;
const LAT_M = 0.0111; // metres per 1e-7 degree of latitude
const arg = (n, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : def;
};

// Copies of the helpers in build-area.mjs (they are not exported there).
function tileToFixed(z, tx, ty, px, py, extent) {
  const n = 2 ** z;
  const x = tx + px / extent;
  const y = ty + py / extent;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [toFixed7(lat), toFixed7(lon)];
}
const insideTile = (px, py, extent) => px >= 0 && px <= extent && py >= 0 && py <= extent;
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
  get([lat, lon]) {
    const ci = Math.floor(lat / SNAP_TOLERANCE);
    const cj = Math.floor(lon / SNAP_TOLERANCE);
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (const id of this.cells.get(`${ci + di},${cj + dj}`) || []) {
          const n = this.nodes[id];
          if (Math.abs(n.lat - lat) <= SNAP_TOLERANCE && Math.abs(n.lon - lon) <= SNAP_TOLERANCE) return id;
        }
    const id = this.nodes.length;
    this.nodes.push({ lat, lon });
    const key = `${ci},${cj}`;
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(id);
    return id;
  }
}

async function buildGraph(bbox, zoom) {
  const cacheDir = join(ROOT, "data", "cache");
  const versions = (await readdir(cacheDir)).filter((v) => /^\d{8}_\d{6}/.test(v)).sort();
  const cacheRoot = join(cacheDir, versions[versions.length - 1]);
  const nodes = new NodeIndex();
  const edges = [];
  const classNames = {};
  for (const t of tilesForBbox(bbox, zoom)) {
    const buf = await readCachedTile(cacheRoot, t.z, t.x, t.y);
    if (!buf || buf.length === 0) continue;
    const layer = decodeTile(buf).find((l) => l.name === "transportation");
    if (!layer) continue;
    for (const f of layer.features) {
      if (f.type !== 2) continue;
      const roadClass = ROAD_CLASS[f.tags.class];
      if (!roadClass) continue;
      let flags = 0;
      if (f.tags.brunnel === "bridge") flags |= 2;
      if (f.tags.brunnel === "tunnel") flags |= 4;
      if (f.tags.toll) flags |= 8;
      if (f.tags.access === "no" || f.tags.access === "private") flags |= 16;
      const ow = f.tags.oneway;
      if (ow === 1 || ow === -1) flags |= 1;
      for (const part of f.parts)
        for (const run of ownedRuns(part, layer.extent)) {
          const ordered = ow === -1 ? run.slice().reverse() : run;
          const points = ordered.map(([x, y]) => tileToFixed(t.z, t.x, t.y, x, y, layer.extent));
          const from = nodes.get(points[0]);
          const to = nodes.get(points[points.length - 1]);
          if (from === to && points.length < 3) continue;
          edges.push({ from, to, roadClass, flags, points, cls: f.tags.class });
          classNames[roadClass] = f.tags.class;
        }
    }
  }
  const crossed = joinCrossings(edges);
  return splitAtSharedVertices(crossed.edges);
}

// Distance in metres between two [lat, lon] points (fixed units), at the given latitude.
const COS = Math.cos((51.5 * Math.PI) / 180);
const metres = (a, b) => Math.hypot((a[0] - b[0]) * LAT_M, (a[1] - b[1]) * LAT_M * COS);
const deg = (r) => Math.round((r * 180) / Math.PI);
const fmt = (p) => `${(p[0] / 1e7).toFixed(6)},${(p[1] / 1e7).toFixed(6)}`;

// Angle at v between directions to a and b, optionally with longitude scaled to true distance.
function angle(v, a, b, scaled) {
  const k = scaled ? COS : 1;
  const ax = a[0] - v[0];
  const ay = (a[1] - v[1]) * k;
  const bx = b[0] - v[0];
  const by = (b[1] - v[1]) * k;
  return Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
}

function nearestIndex(pts, t) {
  let best = 0;
  let bd = Infinity;
  pts.forEach((p, i) => {
    const d = metres(p, t);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}
const neighbour = (pts, i) => (i === 0 ? pts[1] : i === pts.length - 1 ? pts[pts.length - 2] : pts[i - 1]);

function histogram(values, bounds) {
  const h = {};
  for (const v of values) {
    const key = bounds.find((b) => v <= b) ?? `>${bounds[bounds.length - 1]}`;
    h[key] = (h[key] || 0) + 1;
  }
  return h;
}

const name = arg("name", "london");
const bbox = arg("bbox", "-0.55,51.28,0.30,51.70").split(",").map(Number);
const zoom = Number(arg("zoom", "14"));
const records = JSON.parse(await readFile(join(ROOT, "data", "osm-cache", "restrictions", `${name}.json`), "utf8"));
const { nodes, edges } = await buildGraph(bbox, zoom);
console.log(`graph: ${nodes.length} nodes, ${edges.length} edges; ${records.length} restriction records`);

const res = matchRestrictions(nodes, edges, records);
console.log(`matched ${res.matched.length} (${((100 * res.matched.length) / records.length).toFixed(1)}%), unmatched ${JSON.stringify(res.unmatched)}`);
const matchedKinds = res.matched.reduce((m, r) => ((m[r.kind] = (m[r.kind] || 0) + 1), m), {});
console.log(`matched by kind ${JSON.stringify(matchedKinds)}`);

// Spatial index of edge vertices and node positions, for looking around a point.
const CELL = 5000;
const cellOf = (p) => `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
const vertexGrid = new Map();
const nodeGrid = new Map();
const addTo = (grid, key, val) => (grid.has(key) ? grid.get(key).push(val) : grid.set(key, [val]));
nodes.forEach((n, i) => addTo(nodeGrid, cellOf([n.lat, n.lon]), i));
edges.forEach((e, ei) => e.points.forEach((p, pi) => addTo(vertexGrid, cellOf(p), [ei, pi])));
const around = (grid, p) => {
  const out = [];
  const ci = Math.floor(p[0] / CELL);
  const cj = Math.floor(p[1] / CELL);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) out.push(...(grid.get(`${ci + a},${cj + b}`) || []));
  return out;
};
const nearestNode = (p) => {
  let best = -1;
  let bd = Infinity;
  for (const i of around(nodeGrid, p)) {
    const d = metres(p, [nodes[i].lat, nodes[i].lon]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return { node: best, d: bd };
};
// Distance from p to the nearest point on any edge segment nearby (metres).
const nearestSegment = (p) => {
  let bd = Infinity;
  let bedge = -1;
  const seen = new Set();
  for (const [ei] of around(vertexGrid, p)) {
    if (seen.has(ei)) continue;
    seen.add(ei);
    const pts = edges[ei].points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i][0];
      const ay = pts[i][1] * COS;
      const bx = pts[i + 1][0];
      const by = pts[i + 1][1] * COS;
      const px = p[0];
      const py = p[1] * COS;
      const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2));
      const d = Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))) * LAT_M;
      if (d < bd) {
        bd = d;
        bedge = ei;
      }
    }
  }
  return { d: bd, edge: bedge };
};

const byReason = { noVia: [], noFrom: [], noTo: [] };
for (const f of res.failed) byReason[f.reason].push(f.record);

// Class noVia
{
  const list = byReason.noVia;
  console.log(`\n=== noVia: ${list.length} ===`);
  const info = list.map((r) => {
    const nn = nearestNode(r.via);
    const ns = nearestSegment(r.via);
    return { r, nodeD: nn.d, segD: ns.d, segClass: ns.edge >= 0 ? edges[ns.edge].cls : "-", kind: r.kind };
  });
  console.log("distance to nearest graph node (m):", JSON.stringify(histogram(info.map((i) => i.nodeD), [3, 5, 8, 12, 20, 40])));
  console.log("distance to nearest road line (m):", JSON.stringify(histogram(info.map((i) => i.segD), [1, 3, 5, 10, 20, 50])));
  const mid = info.filter((i) => i.segD <= 3 && i.nodeD > 3);
  console.log(`on a road line (<=3 m) but not near a node: ${mid.length}; no road within 20 m: ${info.filter((i) => i.segD > 20).length}`);
  for (const t of [5, 8, 12, 20]) console.log(`  via within ${t} m of a node: ${info.filter((i) => i.nodeD <= t).length}`);
  const sorted = info.slice().sort((a, b) => a.nodeD - b.nodeD);
  const pick = [...sorted.slice(0, 7), ...sorted.slice(Math.floor(sorted.length / 2), Math.floor(sorted.length / 2) + 6), ...sorted.slice(-6)];
  for (const i of pick) console.log(`  via ${fmt(i.r.via)} nearestNode ${i.nodeD.toFixed(1)} m, nearestRoad ${i.segD.toFixed(1)} m (${i.segClass}), kind ${i.kind}`);
}

// Class noFrom and noTo: look at the candidate edges around the via node.
function explain(r, wantFrom) {
  const nn = nearestNode(r.via);
  const v = nn.node;
  const node = [nodes[v].lat, nodes[v].lon];
  const way = wantFrom ? r.from : r.to;
  const ref = neighbour(way, nearestIndex(way, r.via));
  const cands = [];
  edges.forEach((e, ei) => {
    if (e.from !== v && e.to !== v) return;
    const atTo = e.to === v;
    const nb = atTo ? e.points[e.points.length - 2] : e.points[1];
    const oneway = !!(e.flags & 1);
    // Travel arrives at v if the edge ends at v, or starts at v and is two-way; departs is the opposite.
    const ok = wantFrom ? atTo || !oneway : !atTo || !oneway;
    cands.push({ ei, cls: e.cls, oneway, atTo, ok, a: deg(angle(node, ref, nb, false)), as: deg(angle(node, ref, nb, true)), nbD: metres(node, nb), len: e.points.length });
  });
  return { v, node, ref, refD: metres(node, ref), cands, nodeD: nn.d };
}
// Point at `dist` metres along edge e, walking away from node v (at one end of the edge).
function pointAlong(e, v, dist) {
  const pts = e.to === v && e.from !== v ? e.points.slice().reverse() : e.points;
  let left = dist;
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = metres(pts[i], pts[i + 1]);
    if (seg >= left && seg > 0) {
      const t = left / seg;
      return [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])];
    }
    left -= seg;
  }
  return pts[pts.length - 1];
}
// Does some edge at node v (usable the needed way) leave in the direction of `ref`, comparing at `dist` metres?
function bestAtDistance(v, ref, wantFrom, dist, exclude = -1) {
  const node = [nodes[v].lat, nodes[v].lon];
  let best = Infinity;
  edges.forEach((e, ei) => {
    if (ei === exclude || (e.from !== v && e.to !== v)) return;
    const atTo = e.to === v;
    const oneway = !!(e.flags & 1);
    if (!(wantFrom ? atTo || !oneway : !atTo || !oneway)) return;
    best = Math.min(best, angle(node, ref, pointAlong(e, v, dist), true));
  });
  return deg(best);
}
const sameWay = (r) => {
  const key = (pts) => pts.map((p) => p.join(",")).sort().join("|");
  return key(r.from) === key(r.to);
};
for (const [reason, wantFrom] of [["noFrom", true], ["noTo", false]]) {
  const list = byReason[reason];
  console.log(`\n=== ${reason}: ${list.length} ===`);
  const ex = list.map((r) => ({ r, x: explain(r, wantFrom) }));
  const cat = {};
  const bump = (k) => (cat[k] = (cat[k] || 0) + 1);
  for (const { x } of ex) {
    const ok = x.cands.filter((c) => c.ok);
    if (x.cands.length === 0) bump("no edge touches the node");
    else if (ok.length === 0) bump("edges touch the node but none can be travelled the needed way (one-way)");
    else {
      const best = Math.min(...ok.map((c) => c.a));
      const bestScaled = Math.min(...ok.map((c) => c.as));
      if (bestScaled <= 60) bump("angle too large unscaled but <= 60 deg when longitude is scaled");
      else if (bestScaled <= 90) bump("best angle 60-90 deg (scaled)");
      else bump("best angle > 90 deg (scaled)");
      if (best > 60 && bestScaled > 60 && ok.length === 1) bump("  (only one usable edge)");
    }
    if (x.refD < 2) bump("  (OSM neighbour point closer than 2 m to via)");
    if (x.cands.length === 1) bump("  (node has a single edge: dead end or tile seam)");
  }
  console.log(JSON.stringify(cat, null, 1));
  const uturn = ex.filter((e) => sameWay(e.r));
  console.log(`from way and to way are the same way (U-turn): ${uturn.length}`);
  const rest = ex.filter((e) => !sameWay(e.r));
  const hyp = { rest: rest.length, nearbyNodeMatches: 0, farDirection20mLe45: 0, farDirection20mLe60: 0, farDirection40mLe45: 0, noEdgeAtAll: 0, oneEdgeOnly: 0 };
  for (const { r, x } of rest) {
    if (x.cands.length === 0) hyp.noEdgeAtAll++;
    if (x.cands.length === 1) hyp.oneEdgeOnly++;
    const way = wantFrom ? r.from : r.to;
    const ref = x.ref;
    // Direction compared further along the roads rather than at the first point.
    const d20 = bestAtDistance(x.v, ref, wantFrom, Math.min(20, Math.max(5, x.refD)));
    if (d20 <= 45) hyp.farDirection20mLe45++;
    if (d20 <= 60) hyp.farDirection20mLe60++;
    if (bestAtDistance(x.v, ref, wantFrom, Math.min(40, Math.max(5, x.refD))) <= 45) hyp.farDirection40mLe45++;
    // Another node within 15 m of the via point.
    for (const i of around(nodeGrid, r.via)) {
      if (i === x.v || metres(r.via, [nodes[i].lat, nodes[i].lon]) > 15) continue;
      if (bestAtDistance(i, ref, wantFrom, 15) <= 45) {
        hyp.nearbyNodeMatches++;
        break;
      }
    }
  }
  console.log("hypotheses (non U-turn records):", JSON.stringify(hyp));
  const bestAngles = ex.filter((e) => e.x.cands.some((c) => c.ok)).map((e) => Math.min(...e.x.cands.filter((c) => c.ok).map((c) => c.as)));
  console.log("best usable angle, scaled (deg):", JSON.stringify(histogram(bestAngles, [30, 45, 60, 75, 90, 120, 150])));
  console.log("via node distance to the OSM via point (m):", JSON.stringify(histogram(ex.map((e) => e.x.nodeD), [0.5, 1, 2, 3])));
  const kinds = {};
  for (const { x } of ex) for (const c of x.cands) kinds[c.cls] = (kinds[c.cls] || 0) + 1;
  console.log("classes of edges at these via nodes:", JSON.stringify(kinds));
  const step = Math.max(1, Math.floor(ex.length / 16));
  for (let i = 0; i < ex.length; i += step) {
    const { r, x } = ex[i];
    console.log(`  via ${fmt(r.via)} kind ${r.kind} node ${x.nodeD.toFixed(1)} m, OSM neighbour ${x.refD.toFixed(1)} m away, bearing-ref ${fmt(x.ref)}`);
    for (const c of x.cands) console.log(`     edge ${c.ei} ${c.cls} ${c.oneway ? "oneway" : "twoway"} ${c.atTo ? "ends" : "starts"} here usable=${c.ok} angle ${c.a}/${c.as} deg, neighbour ${c.nbD.toFixed(1)} m, ${c.len} pts`);
  }
}
