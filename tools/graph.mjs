// Road graph repair: splits roads wherever another road shares a point with them,
// so that every junction becomes a node the router can turn at. Our own code.

const SNAP = 200; // 1e-7 degree units: about 2 m, same as the builder

class VertexIndex {
  constructor() {
    this.verts = [];
    this.cells = new Map();
  }

  // Returns the vertex id for a point, creating one if no vertex is within SNAP.
  id(lat, lon) {
    const ci = Math.floor(lat / SNAP);
    const cj = Math.floor(lon / SNAP);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const ids = this.cells.get(`${ci + di},${cj + dj}`);
        if (!ids) continue;
        for (const v of ids) {
          const w = this.verts[v];
          if (Math.abs(w.lat - lat) <= SNAP && Math.abs(w.lon - lon) <= SNAP) return v;
        }
      }
    }
    const v = this.verts.length;
    this.verts.push({ lat, lon, uses: new Set() });
    const key = `${ci},${cj}`;
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(v);
    return v;
  }
}

// edges: [{ roadClass, flags, points: [[lat, lon], ...] }] in fixed-point units.
// Returns { nodes, edges } where each edge runs between two junction nodes.
export function splitAtSharedVertices(edges) {
  const index = new VertexIndex();
  const pointIds = edges.map((e, ei) =>
    e.points.map(([lat, lon]) => {
      const v = index.id(lat, lon);
      index.verts[v].uses.add(ei);
      return v;
    }),
  );

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
      pieces.push({
        from: ids[a],
        to: ids[b],
        roadClass: e.roadClass,
        flags: e.flags,
        points: e.points.slice(a, b + 1),
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
