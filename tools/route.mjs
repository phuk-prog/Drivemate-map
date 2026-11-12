// Routing on a DMAP map: our own graph build and A* search. No third-party code.
// Usage: node --max-old-space-size=12000 tools/route.mjs data/out/london.dmap lat1,lon1 lat2,lon2
// Coordinates are decimal degrees. Each point is snapped to the nearest road junction.

import { readFile } from "node:fs/promises";
import { readDmap, fromFixed7 } from "./dmap.mjs";

const EARTH_RADIUS = 6371000;
const NO_ACCESS_FLAG = 16;
const ONEWAY_FLAG = 1;

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Minimal binary heap keyed by priority.
class MinHeap {
  constructor() {
    this.items = [];
  }
  push(priority, value) {
    const a = this.items;
    a.push({ priority, value });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].priority <= a[i].priority) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].priority < a[m].priority) m = l;
        if (r < a.length && a[r].priority < a[m].priority) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.items.length;
  }
}

export function buildGraph(map) {
  const n = map.nodes.length;
  const adj = Array.from({ length: n }, () => []);
  const lengths = new Float64Array(map.edges.length);
  map.edges.forEach((e, idx) => {
    if (e.flags & NO_ACCESS_FLAG) return;
    let len = 0;
    for (let k = 0; k + 1 < e.points.length; k++) {
      len += haversine(
        fromFixed7(e.points[k][0]), fromFixed7(e.points[k][1]),
        fromFixed7(e.points[k + 1][0]), fromFixed7(e.points[k + 1][1]),
      );
    }
    lengths[idx] = len;
    adj[e.from].push({ to: e.to, edge: idx });
    if (!(e.flags & ONEWAY_FLAG)) adj[e.to].push({ to: e.from, edge: idx });
  });
  // Connected components over routable roads. The router only uses the largest one.
  const comp = new Int32Array(n).fill(-1);
  const sizes = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || adj[s].length === 0) continue;
    const id = sizes.length;
    const stack = [s];
    comp[s] = id;
    let size = 0;
    while (stack.length) {
      const v = stack.pop();
      size++;
      for (const { to } of adj[v]) {
        if (comp[to] < 0) {
          comp[to] = id;
          stack.push(to);
        }
      }
    }
    sizes.push(size);
  }
  const main = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;
  return { adj, lengths, comp, main, components: sizes.length };
}

// Nearest junction in the largest connected road network, to a point.
// Brute force, fine for a single query.
export function snapToNode(map, lat, lon, graph) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < map.nodes.length; i++) {
    if (graph && graph.comp[i] !== graph.main) continue;
    const d = haversine(lat, lon, fromFixed7(map.nodes[i].lat), fromFixed7(map.nodes[i].lon));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { node: best, distance: bestD };
}

// A* from one node to another. Returns { nodes, edges, meters } or null.
export function route(map, graph, from, to) {
  const { adj, lengths } = graph;
  const goalLat = fromFixed7(map.nodes[to].lat);
  const goalLon = fromFixed7(map.nodes[to].lon);
  const h = (node) => haversine(fromFixed7(map.nodes[node].lat), fromFixed7(map.nodes[node].lon), goalLat, goalLon);

  const gScore = new Map([[from, 0]]);
  const cameFrom = new Map();
  const heap = new MinHeap();
  heap.push(h(from), from);
  const closed = new Set();

  while (heap.size > 0) {
    const { value: node } = heap.pop();
    if (node === to) {
      const nodes = [to];
      const edges = [];
      let cur = to;
      while (cur !== from) {
        const step = cameFrom.get(cur);
        edges.push(step.edge);
        nodes.push(step.from);
        cur = step.from;
      }
      nodes.reverse();
      edges.reverse();
      return { nodes, edges, meters: gScore.get(to) };
    }
    if (closed.has(node)) continue;
    closed.add(node);
    const g = gScore.get(node);
    for (const { to: next, edge } of adj[node]) {
      if (closed.has(next)) continue;
      const tentative = g + lengths[edge];
      if (tentative < (gScore.get(next) ?? Infinity)) {
        gScore.set(next, tentative);
        cameFrom.set(next, { from: node, edge });
        heap.push(tentative + h(next), next);
      }
    }
  }
  return null;
}

// Route geometry as lat/lon pairs, following each edge's points in travel order.
export function routeGeometry(map, result) {
  const out = [];
  result.edges.forEach((idx, i) => {
    const e = map.edges[idx];
    const forward = e.from === result.nodes[i];
    const pts = forward ? e.points : e.points.slice().reverse();
    for (const p of out.length ? pts.slice(1) : pts) out.push(p);
  });
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const [, , file, a, b] = process.argv;
  const [lat1, lon1] = a.split(",").map(Number);
  const [lat2, lon2] = b.split(",").map(Number);
  const map = readDmap(await readFile(file));
  const t0 = Date.now();
  const graph = buildGraph(map);
  const built = Date.now() - t0;
  const s = snapToNode(map, lat1, lon1, graph);
  const e = snapToNode(map, lat2, lon2, graph);
  const t1 = Date.now();
  const result = route(map, graph, s.node, e.node);
  const searched = Date.now() - t1;
  if (!result) {
    console.log("no route found");
  } else {
    console.log(JSON.stringify({
      graphBuildMs: built,
      searchMs: searched,
      kilometres: +(result.meters / 1000).toFixed(2),
      edges: result.edges.length,
      snapMetres: [Math.round(s.distance), Math.round(e.distance)],
    }, null, 2));
  }
}
