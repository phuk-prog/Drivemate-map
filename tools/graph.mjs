// Road graph repair: splits roads wherever another road shares a point with them,
// so that every junction becomes a node the router can turn at. Also joins roads
// that cross in the middle, and road ends that stop short of another road's middle.
// Our own code.

// Points within SNAP_M metres of each other are the same junction. Points are in 1e-7 degree
// units: one unit is about 1.11 cm north-south, and about 1.11 cm * cos(latitude) east-west.
const SNAP_M = 2;
const METRES_PER_UNIT = ((6371000 * Math.PI) / 180) * 1e-7; // Earth radius 6371 km
const RADIANS_PER_UNIT = (1e-7 * Math.PI) / 180;
const INDEX_CELL = 400; // grid cell for the vertex index, in 1e-7 degree units: about 4.4 m north-south

// Squared distance in square metres between two points on the ground.
function dist2(lat1, lon1, lat2, lon2) {
  const dy = (lat1 - lat2) * METRES_PER_UNIT;
  const dx = (lon1 - lon2) * METRES_PER_UNIT * Math.cos(((lat1 + lat2) / 2) * RADIANS_PER_UNIT);
  return dx * dx + dy * dy;
}

// True when two points are within SNAP_M metres of each other on the ground.
function near(lat1, lon1, lat2, lon2) {
  return dist2(lat1, lon1, lat2, lon2) <= SNAP_M * SNAP_M;
}

class VertexIndex {
  constructor() {
    this.verts = [];
    this.cells = new Map();
  }

  // The vertex that a vertex id now stands for. Merged vertices point at the one they joined.
  find(v) {
    while (this.verts[v].parent !== v) v = this.verts[v].parent;
    return v;
  }

  // Returns the vertex id for a point. Every point keeps its own position in the index, so a point is
  // compared with each earlier point, not with the merged position of a group. Points within SNAP_M
  // metres of it are merged into one vertex, whatever order the points were added in. The vertex
  // keeps the coordinates of the root of the nearest point. A new vertex is made if none is within SNAP_M.
  id(lat, lon) {
    const v = this.verts.length;
    this.verts.push({ lat, lon, uses: new Set(), parent: v });
    const ci = Math.floor(lat / INDEX_CELL);
    const cj = Math.floor(lon / INDEX_CELL);
    // Cells to search each way. East-west distance per unit grows as 1/cos(latitude), so this can be more than 1.
    const reach = Math.ceil(SNAP_M / (METRES_PER_UNIT * Math.cos(lat * RADIANS_PER_UNIT)) / INDEX_CELL);
    const roots = [];
    let best = -1;
    let bestD = Infinity;
    for (let di = -reach; di <= reach; di++) {
      for (let dj = -reach; dj <= reach; dj++) {
        const ids = this.cells.get(`${ci + di},${cj + dj}`);
        if (!ids) continue;
        for (const u of ids) {
          const w = this.verts[u];
          if (!near(w.lat, w.lon, lat, lon)) continue;
          const r = this.find(u);
          if (!roots.includes(r)) roots.push(r);
          const d = dist2(w.lat, w.lon, lat, lon);
          if (d < bestD) {
            bestD = d;
            best = r;
          }
        }
      }
    }
    const key = `${ci},${cj}`;
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(v);
    if (best < 0) return v;
    for (const r of [...roots, v]) {
      if (r === best) continue;
      this.verts[r].parent = best;
      for (const e of this.verts[r].uses) this.verts[best].uses.add(e);
    }
    return best;
  }
}

// edges: [{ roadClass, flags, points: [[lat, lon], ...] }] in fixed-point units.
// Returns { nodes, edges } where each edge runs between two junction nodes.
export function splitAtSharedVertices(edges) {
  const index = new VertexIndex();
  const rawIds = edges.map((e, ei) =>
    e.points.map(([lat, lon]) => {
      const v = index.id(lat, lon);
      index.verts[v].uses.add(ei);
      return v;
    }),
  );
  // Later points can merge earlier vertices, so resolve every id to its final vertex.
  const pointIds = rawIds.map((ids) => ids.map((v) => index.find(v)));

  const pieces = [];
  edges.forEach((e, ei) => {
    const ids = pointIds[ei];
    const cuts = [0];
    for (let k = 1; k < ids.length - 1; k++) {
      if (index.verts[ids[k]].uses.size > 1) cuts.push(k);
    }
    cuts.push(ids.length - 1);
    for (let c = 0; c + 1 < cuts.length; c++) {
      const a = cuts[c];
      const b = cuts[c + 1];
      const points = e.points.slice(a, b + 1);
      // Each piece starts and ends exactly on its junction node. A road end joined from up to
      // SNAP_M away would otherwise sit too far from its node for the validator's EDGE_END_TOLERANCE.
      const from = index.verts[ids[a]];
      const to = index.verts[ids[b]];
      points[0] = [from.lat, from.lon];
      points[points.length - 1] = [to.lat, to.lon];
      pieces.push({
        from: ids[a],
        to: ids[b],
        roadClass: e.roadClass,
        flags: e.flags,
        points,
      });
    }
  });

  // Renumber so that only junctions used by an edge become nodes.
  const newId = new Map();
  const nodes = [];
  const idOf = (v) => {
    if (!newId.has(v)) {
      newId.set(v, nodes.length);
      nodes.push({ lat: index.verts[v].lat, lon: index.verts[v].lon });
    }
    return newId.get(v);
  };
  const out = pieces.map((p) => ({
    from: idOf(p.from),
    to: idOf(p.to),
    roadClass: p.roadClass,
    flags: p.flags,
    points: p.points,
  }));
  return { nodes, edges: out };
}

// Crossings: finds where two at-grade roads cross in the middle of a line, with no
// shared point, and inserts the crossing point into both roads. splitAtSharedVertices
// then makes it a junction. Bridges and tunnels are skipped, since they pass over or
// under other roads without meeting them. Roads with different OSM layer values (edge.layer,
// missing means 0) are skipped too: the layer tag says one passes above the other. Returns
// { edges, joins, layerSkipped } where joins is the number of crossings joined and
// layerSkipped the number of crossings left apart because the layers differ.
const CELL = 20000; // grid cell in 1e-7 degree units: about 220 m
const BRIDGE_OR_TUNNEL = 2 | 4;

// Intersection of segment p->q with segment r->s. Returns null unless the two
// segments cross at a point inside both. t is the position on p->q, u on r->s.
function segmentCrossing(p, q, r, s) {
  const rx = q[0] - p[0];
  const ry = q[1] - p[1];
  const sx = s[0] - r[0];
  const sy = s[1] - r[1];
  const d = rx * sy - ry * sx;
  if (d === 0) return null; // parallel or collinear
  const wx = r[0] - p[0];
  const wy = r[1] - p[1];
  const t = (wx * sy - wy * sx) / d;
  const u = (wx * ry - wy * rx) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, point: [Math.round(p[0] + t * rx), Math.round(p[1] + t * ry)] };
}

// True when two points are within SNAP_M metres of each other, the same rule as the vertex index.
function nearPoint(a, b) {
  return near(a[0], a[1], b[0], b[1]);
}

// OSM layer of a road: 0 when the tile does not carry one.
const layerOf = (e) => e.layer ?? 0;

export function joinCrossings(edges) {
  // Index every at-grade segment by the grid cells its bounding box covers.
  const segEdge = [];
  const segIndex = [];
  const segMinI = [];
  const segMinJ = [];
  const grid = new Map(); // "ci,cj" -> { ci, cj, ids: [segment ids] }
  edges.forEach((e, ei) => {
    if (e.flags & BRIDGE_OR_TUNNEL) return;
    const pts = e.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const id = segEdge.length;
      const [a, b] = [pts[i], pts[i + 1]];
      const minI = Math.floor(Math.min(a[0], b[0]) / CELL);
      const maxI = Math.floor(Math.max(a[0], b[0]) / CELL);
      const minJ = Math.floor(Math.min(a[1], b[1]) / CELL);
      const maxJ = Math.floor(Math.max(a[1], b[1]) / CELL);
      segEdge.push(ei);
      segIndex.push(i);
      segMinI.push(minI);
      segMinJ.push(minJ);
      for (let ci = minI; ci <= maxI; ci++) {
        for (let cj = minJ; cj <= maxJ; cj++) {
          const key = `${ci},${cj}`;
          let cell = grid.get(key);
          if (!cell) grid.set(key, (cell = { ci, cj, ids: [] }));
          cell.ids.push(id);
        }
      }
    }
  });

  // Test pairs of segments from different roads. A pair is tested only in the cell
  // where their boxes first overlap, so no pair is tested twice and no set is needed.
  const inserts = edges.map(() => []); // per edge: { seg, t, point }
  let joins = 0;
  let layerSkipped = 0;
  for (const cell of grid.values()) {
    const ids = cell.ids;
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const s1 = ids[x];
        const s2 = ids[y];
        const e1 = segEdge[s1];
        const e2 = segEdge[s2];
        if (e1 === e2) continue;
        if (cell.ci !== Math.max(segMinI[s1], segMinI[s2]) || cell.cj !== Math.max(segMinJ[s1], segMinJ[s2])) continue;

        const i1 = segIndex[s1];
        const i2 = segIndex[s2];
        const p = edges[e1].points;
        const r = edges[e2].points;
        const hit = segmentCrossing(p[i1], p[i1 + 1], r[i2], r[i2 + 1]);
        if (!hit) continue;
        // A crossing right at a road end is already a shared point (or a near miss
        // that the vertex index merges), so no point is added at that end.
        const addTo1 = !nearPoint(hit.point, p[i1]) && !nearPoint(hit.point, p[i1 + 1]);
        const addTo2 = !nearPoint(hit.point, r[i2]) && !nearPoint(hit.point, r[i2 + 1]);
        if (!addTo1 && !addTo2) {
          joins++; // already a shared point: nothing to insert
          continue;
        }
        // Roads at different layers pass over or under each other, so no junction is made.
        if (layerOf(edges[e1]) !== layerOf(edges[e2])) {
          layerSkipped++;
          continue;
        }
        joins++;
        if (addTo1) inserts[e1].push({ seg: i1, t: hit.t, point: hit.point });
        if (addTo2) inserts[e2].push({ seg: i2, t: hit.u, point: hit.point });
      }
    }
  }

  return { edges: applyInserts(edges, inserts), joins, layerSkipped };
}

// Rebuilds each edge's points with the inserted points, in order along the road. An insert is
// { seg, t, point }: the point goes after point seg of the edge, at position t along that segment.
function applyInserts(edges, inserts) {
  return edges.map((e, ei) => {
    const add = inserts[ei];
    if (add.length === 0) return e;
    add.sort((a, b) => a.seg - b.seg || a.t - b.t);
    const pts = [];
    let next = 0;
    const push = (pt) => {
      const last = pts[pts.length - 1];
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) pts.push(pt);
    };
    for (let k = 0; k < e.points.length; k++) {
      push(e.points[k]);
      while (next < add.length && add[next].seg === k) {
        push(add[next].point);
        next++;
      }
    }
    return { ...e, points: pts };
  });
}

// The point on segment a->b nearest to p, rounded to 1e-7 degree units, and its position t
// (0 to 1) along a->b. East-west distances are scaled at p's latitude, as near() does.
function nearestOnSegment(p, a, b) {
  const k = Math.cos(p[0] * RADIANS_PER_UNIT);
  const dx = (b[1] - a[1]) * k;
  const dy = b[0] - a[0];
  const L2 = dx * dx + dy * dy;
  let t = L2 === 0 ? 0 : (((p[1] - a[1]) * k) * dx + (p[0] - a[0]) * dy) / L2;
  t = Math.min(1, Math.max(0, t));
  return { t, point: [Math.round(a[0] + t * (b[0] - a[0])), Math.round(a[1] + t * (b[1] - a[1]))] };
}

// Road ends that stop short of another road. An end within SNAP_M metres of another road's
// middle segment is joined to it: the nearest point on that segment is inserted into the other road,
// and splitAtSharedVertices merges it with the end. An end that already has another road's point
// within SNAP_M is shared already, so it is left alone. Bridges and tunnels are skipped, and roads
// with different OSM layer values are not joined, as for crossings. Returns { edges, joins, layerSkipped }
// where joins is the number of road ends joined and layerSkipped the number left apart by layer.
export function joinRoadEnds(edges) {
  const pointCells = new Map(); // "ci,cj" -> [point ids], every point of every road
  const pointEdge = [];
  const pointAt = [];
  const segCells = new Map(); // "ci,cj" -> [segment ids], at-grade segments by bounding box
  const segEdge = [];
  const segIndex = [];
  const addTo = (map, key, id) => {
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(id);
  };
  edges.forEach((e, ei) => {
    const pts = e.points;
    for (const p of pts) {
      const id = pointEdge.length;
      pointEdge.push(ei);
      pointAt.push(p);
      addTo(pointCells, `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`, id);
    }
    if (e.flags & BRIDGE_OR_TUNNEL) return;
    for (let i = 0; i + 1 < pts.length; i++) {
      const id = segEdge.length;
      segEdge.push(ei);
      segIndex.push(i);
      const [a, b] = [pts[i], pts[i + 1]];
      const minI = Math.floor(Math.min(a[0], b[0]) / CELL);
      const maxI = Math.floor(Math.max(a[0], b[0]) / CELL);
      const minJ = Math.floor(Math.min(a[1], b[1]) / CELL);
      const maxJ = Math.floor(Math.max(a[1], b[1]) / CELL);
      for (let ci = minI; ci <= maxI; ci++) {
        for (let cj = minJ; cj <= maxJ; cj++) addTo(segCells, `${ci},${cj}`, id);
      }
    }
  });

  // Ids in the 3 by 3 cells around p. Anything within SNAP_M of p is in these cells, since SNAP_M is far below CELL.
  const around = (map, p) => {
    const ci = Math.floor(p[0] / CELL);
    const cj = Math.floor(p[1] / CELL);
    const out = [];
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const list = map.get(`${ci + di},${cj + dj}`);
        if (list) for (const id of list) out.push(id);
      }
    }
    return out;
  };

  const inserts = edges.map(() => []); // per edge: { seg, t, point }
  let joins = 0;
  let layerSkipped = 0;
  edges.forEach((e, ei) => {
    if (e.flags & BRIDGE_OR_TUNNEL) return;
    const last = e.points.length - 1;
    if (last < 1) return;
    for (const k of [0, last]) {
      const p = e.points[k];
      if (around(pointCells, p).some((id) => pointEdge[id] !== ei && nearPoint(pointAt[id], p))) continue; // already shared

      let best = null;
      let otherLayer = false;
      for (const sid of around(segCells, p)) {
        const te = segEdge[sid];
        if (te === ei) continue;
        const i = segIndex[sid];
        const q = edges[te].points;
        const hit = nearestOnSegment(p, q[i], q[i + 1]);
        if (!nearPoint(hit.point, p)) continue; // the nearest point is more than SNAP_M from the end
        // A point at a segment's end would be a junction already: the end is not joined there.
        if (nearPoint(hit.point, q[i]) || nearPoint(hit.point, q[i + 1])) continue;
        // Roads at different layers pass over or under each other, so the end is not joined to them.
        if (layerOf(edges[te]) !== layerOf(e)) {
          otherLayer = true;
          continue;
        }
        const d = dist2(p[0], p[1], hit.point[0], hit.point[1]);
        if (!best || d < best.d) best = { d, te, i, t: hit.t, point: hit.point };
      }
      if (best) {
        joins++;
        inserts[best.te].push({ seg: best.i, t: best.t, point: best.point });
      } else if (otherLayer) {
        layerSkipped++;
      }
    }
  });
  return { edges: applyInserts(edges, inserts), joins, layerSkipped };
}

// Seam duplicates: a tile edge can give the same area twice, from two neighbouring
// tiles. Keeps one area from each group of areas that have the same kind, the same
// place (bounding box to about 11 m) and the same outer boundary (first ring, area within
// 1%). Areas with the same place but a different shape are kept. Only the outer ring is
// compared: a tile can drop a small hole that the neighbouring tile keeps, so the copy with
// more rings is the one kept. Returns the kept areas.
const DUP_BOX = 1000; // 1e-7 degree units: about 1.1 cm grid for the place key
const DUP_AREA = 0.01;

function ringsArea(rings) {
  let total = 0;
  for (const ring of rings) {
    let twice = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      twice += x1 * y2 - x2 * y1;
    }
    total += Math.abs(twice) / 2;
  }
  return total;
}

export function dropSeamDuplicates(polygons) {
  const seen = new Map(); // place key -> [{ area, index in kept }]
  const kept = [];
  for (const p of polygons) {
    let minA = Infinity, minB = Infinity, maxA = -Infinity, maxB = -Infinity;
    // The place is the outer ring's box: a copy with an extra part can have a larger box.
    for (const [a, b] of p.rings[0] || []) {
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    const key = [p.kind, Math.round(minA / DUP_BOX), Math.round(minB / DUP_BOX), Math.round(maxA / DUP_BOX), Math.round(maxB / DUP_BOX)].join("|");
    const area = ringsArea(p.rings.slice(0, 1));
    const list = seen.get(key) || [];
    const hit = list.find((h) => Math.abs(h.area - area) <= DUP_AREA * Math.max(area, 1));
    if (hit) {
      // Same outer boundary: keep the copy with more rings (holes), as the other may have lost one.
      if (p.rings.length > kept[hit.index].rings.length) kept[hit.index] = p;
      continue;
    }
    list.push({ area, index: kept.length });
    seen.set(key, list);
    kept.push(p);
  }
  return kept;
}

// Road duplicates and loops left after the split. A road can come through twice when a tile
// edge or two overlapping OSM ways cover the same stretch. Drops a road when another road
// with the same class and flags has the same points in the same order (or reversed, if the
// road is not one-way). Also drops two-point loops, which have no length. Renumbers the nodes
// so that only junctions still used by a road remain. Takes and returns { nodes, edges }.
const keyOf = (e) => `${e.roadClass}:${e.flags}`;
const pointsKey = (pts) => pts.map(([a, b]) => `${a},${b}`).join(";");

export function dropDuplicateEdges({ nodes, edges }) {
  const seen = new Set();
  const kept = [];
  for (const e of edges) {
    if (e.from === e.to && e.points.length < 3) continue; // two-point loop
    const forward = `${e.from}>${e.to}|${keyOf(e)}|${pointsKey(e.points)}`;
    if (seen.has(forward)) continue;
    if (!(e.flags & 1)) {
      const reversed = `${e.to}>${e.from}|${keyOf(e)}|${pointsKey([...e.points].reverse())}`;
      if (seen.has(reversed)) continue;
    }
    seen.add(forward);
    kept.push(e);
  }

  // Renumber nodes so that only the ones still used remain.
  const newId = new Map();
  const outNodes = [];
  const idOf = (v) => {
    if (!newId.has(v)) {
      newId.set(v, outNodes.length);
      outNodes.push(nodes[v]);
    }
    return newId.get(v);
  };
  const outEdges = kept.map((e) => ({ ...e, from: idOf(e.from), to: idOf(e.to) }));
  return { nodes: outNodes, edges: outEdges };
}
