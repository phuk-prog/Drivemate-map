// Checks lane match quality on real data. Builds the road graph from cached tiles the way
// tools/build-area.mjs does, matches the lane ways from data/osm-cache/lanes/<name>.json, and prints
// a report: lane ways that matched no edge, far or oblique matches, edges with two candidate ways,
// the lane-order convention seen on oneway=-1 ways, and sample suspicious cases with coordinates.
// Usage: node tools/diagnose-lanes.mjs --name=london --bbox=-0.55,51.28,0.30,51.70 --zoom=14
// Writes nothing except the report on stdout.

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeTile } from "./mvt.mjs";
import { readCachedTile, tilesForBbox } from "./fetch-tiles.mjs";
import { toFixed7 } from "./dmap.mjs";
import { splitAtSharedVertices, joinCrossings } from "./graph.mjs";
import { matchLanes } from "./lanes.mjs";
import { ROAD_CLASS } from "./classes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = 200;
const arg = (n, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : def;
};

function tileToFixed(z, tx, ty, px, py, extent) {
  const n = 2 ** z;
  const x = tx + px / extent;
  const y = ty + py / extent;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [toFixed7(lat), toFixed7(lon)];
}
const inside = (x, y, e) => x >= 0 && x <= e && y >= 0 && y <= e;
function ownedRuns(points, extent) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    if (inside(x, y, extent)) {
      if (!cur) {
        cur = [];
        if (i > 0) cur.push(points[i - 1]);
      }
      cur.push([x, y]);
    } else if (cur) {
      cur.push([x, y]);
      runs.push(cur);
      cur = null;
    }
  }
  if (cur && cur.length >= 2) runs.push(cur);
  return runs.filter((r) => r.length >= 2);
}
class NodeIndex {
  constructor() {
    this.nodes = [];
    this.cells = new Map();
  }
  get([lat, lon]) {
    const ci = Math.floor(lat / SNAP);
    const cj = Math.floor(lon / SNAP);
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (const id of this.cells.get(`${ci + di},${cj + dj}`) || []) {
          const n = this.nodes[id];
          if (Math.abs(n.lat - lat) <= SNAP && Math.abs(n.lon - lon) <= SNAP) return id;
        }
    const id = this.nodes.length;
    this.nodes.push({ lat, lon });
    const key = `${ci},${cj}`;
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(id);
    return id;
  }
}

const name = arg("name", "london");
const bbox = arg("bbox", "-0.55,51.28,0.30,51.70").split(",").map(Number);
const zoom = Number(arg("zoom", "14"));
const cacheDir = join(ROOT, "data", "cache");
const versions = (await readdir(cacheDir)).filter((v) => /^\d{8}_\d{6}/.test(v)).sort();
const version = arg("version", versions[versions.length - 1]);

const nodes = new NodeIndex();
const rawEdges = [];
for (const t of tilesForBbox(bbox, zoom)) {
  const buf = await readCachedTile(join(cacheDir, version), t.z, t.x, t.y);
  if (!buf || buf.length === 0) continue;
  const tr = decodeTile(buf).find((l) => l.name === "transportation");
  if (!tr) continue;
  for (const f of tr.features) {
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
      for (const run of ownedRuns(part, tr.extent)) {
        const ordered = ow === -1 ? run.slice().reverse() : run;
        const points = ordered.map(([x, y]) => tileToFixed(t.z, t.x, t.y, x, y, tr.extent));
        const from = nodes.get(points[0]);
        const to = nodes.get(points[points.length - 1]);
        if (from === to && points.length < 3) continue;
        rawEdges.push({ from, to, roadClass, flags, points });
      }
  }
}
const repaired = splitAtSharedVertices(joinCrossings(rawEdges).edges);
const edges = repaired.edges;
const ways = JSON.parse(await readFile(join(ROOT, "data", "osm-cache", "lanes", `${name}.json`), "utf8"));

const result = matchLanes(edges, ways, { details: true });
const metres = (u) => (u * 0.0111).toFixed(1);
const where = (p) => `${(p[0] / 1e7).toFixed(6)},${(p[1] / 1e7).toFixed(6)}`;
const wayDesc = (wi) => `way#${wi} oneway=${ways[wi].oneway || "-"} tags=${JSON.stringify(ways[wi].tags)} at ${where(ways[wi].geom[Math.floor(ways[wi].geom.length / 2)])}`;

// Per-way usage.
const usedBest = new Set();
const usedAny = new Set();
let far5 = 0, far9 = 0, oblique20 = 0, withSecond = 0, secondClose = 0;
const samples = { far: [], oblique: [], second: [], nomatch: [] };
const COS20 = Math.cos((20 * Math.PI) / 180);
result.details.forEach((d, ei) => {
  if (!d) return;
  usedBest.add(d.way);
  usedAny.add(d.way);
  const mid = edges[ei].points[Math.floor(edges[ei].points.length / 2)];
  if (d.dist > 800) far9++;
  if (d.dist > 450) {
    far5++;
    samples.far.push({ ei, mid, d, why: `edge ${metres(d.dist)} m from ${wayDesc(d.way)}` });
  }
  if (Math.abs(d.cos) < COS20) {
    oblique20++;
    samples.oblique.push({ ei, mid, d, why: `angle ${(Math.acos(Math.abs(d.cos)) * 180 / Math.PI).toFixed(0)} deg to ${wayDesc(d.way)}` });
  }
  if (d.second) {
    withSecond++;
    usedAny.add(d.second.way);
    if (Math.abs(d.second.dist - d.dist) < 1200) secondClose++;
    samples.second.push({ ei, mid, d, why: `ways ${d.way} (${metres(d.dist)} m) and ${d.second.way} (${metres(d.second.dist)} m) both fit; texts "${ways[d.way].tags["turn:lanes"] ?? ways[d.way].tags["turn:lanes:forward"] ?? ""}" vs "${ways[d.second.way].tags["turn:lanes"] ?? ways[d.second.way].tags["turn:lanes:forward"] ?? ""}"` });
  }
});
ways.forEach((w, wi) => {
  if (!usedAny.has(wi)) samples.nomatch.push({ mid: w.geom[Math.floor(w.geom.length / 2)], why: wayDesc(wi) });
});

// Lane-order convention: which side's turn comes first on plain turn:lanes.
const conv = {};
for (const w of ways) {
  const t = w.tags["turn:lanes"];
  if (!t || w.tags["turn:lanes:forward"] || w.tags["turn:lanes:backward"]) continue;
  const lanes = t.split("|");
  if (lanes.length < 2) continue;
  const left = (s) => /left/.test(s);
  const right = (s) => /right/.test(s);
  const first = lanes[0], last = lanes[lanes.length - 1];
  let kind = null;
  if (left(first) && !left(last) && !right(first)) kind = "leftFirst";
  else if (right(last) && !right(first) && !left(last)) kind = "leftFirst";
  else if (right(first) && !right(last) && !left(first)) kind = "rightFirst";
  else if (left(last) && !left(first) && !right(last)) kind = "rightFirst";
  else continue;
  // A way that has both kinds of evidence is ignored above; count the rest.
  const ow = w.oneway === "-1" ? "oneway=-1" : w.oneway === "yes" ? "oneway=yes" : "other";
  conv[ow] ??= { leftFirst: 0, rightFirst: 0 };
  conv[ow][kind]++;
}

const unmatchedWays = ways.length - usedAny.size;
const pick = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
console.log(`lane ways: ${ways.length}; edges: ${edges.length}; version ${version}`);
console.log(`match stats: ${JSON.stringify(result.stats)}`);
console.log(`lane ways that matched no edge at all: ${unmatchedWays}`);
console.log(`lane ways never the best match of an edge: ${ways.length - usedBest.size}`);
console.log(`edges matched to a way more than 9 m away: ${far9}; more than 5 m: ${far5}`);
console.log(`edges at an oblique angle (over 20 degrees): ${oblique20}`);
console.log(`edges with two candidate ways: ${withSecond}; of those nearly equally close: ${secondClose}`);
console.log(`lane order on plain turn:lanes by oneway kind (leftFirst = turns listed left to right in the way's direction):`);
console.log(JSON.stringify(conv));
console.log(`\nsample suspicious cases (15):`);
const all = [
  ...pick(samples.nomatch, 5).map((s) => ({ kind: "way matched nothing", ...s })),
  ...pick(samples.far, 4).map((s) => ({ kind: "far match", ...s })),
  ...pick(samples.oblique, 3).map((s) => ({ kind: "oblique", ...s })),
  ...pick(samples.second, 3).map((s) => ({ kind: "two ways", ...s })),
];
for (const s of all.slice(0, 15)) console.log(`- [${s.kind}] ${where(s.mid)}: ${s.why}`);
