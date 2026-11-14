// Road names and signposts: reads OpenStreetMap `name`/`ref` tags for road names and
// `destination`/`exit` tags for signposts, and attaches them to the routable roads in a
// map area by location. Our own code.
//
// One name per edge is stored in the map file (v8+). Signposts are stored separately for
// future use. Names come from the `name` tag (preferred over `ref`). Signposts come from
// the `destination` tag (preferred over `exit`).
//
// Cache records (made by tools/osm-extract.mjs):
//   road names: { name, geom: [[lat, lon], ...] }
//   signposts: { signpost, geom: [[lat, lon], ...] }
// Coordinates are [lat, lon] in 1e-7 degree units, the same as the rest of the map.

const MAX_DISTANCE = 800; // a road matches a way within about 9 m
const MIN_PARALLEL_COS = Math.cos((40 * Math.PI) / 180); // direction must agree within 40 degrees
const CELL = 5000; // grid cell in 1e-7 degree units (about 55 m)

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

// Matches road names to edges. Returns { roadNames: [{ edge, name }], stats }.
export function matchRoadNames(edges, roadNameWays) {
  // Build a spatial index of name ways.
  const segWay = [];
  const segStart = [];
  const grid = new Map();
  roadNameWays.forEach((w, wi) => {
    if (!w.geom || w.geom.length < 2) return;
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

  const roadNames = [];
  const stats = { waysUsed: roadNameWays.filter((w) => w.geom && w.geom.length >= 2).length, matched: 0, noWay: 0, ambiguous: 0 };

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

    // Find the nearest name way segment.
    const nearest = new Map(); // way index -> { d, aligned }
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const id of grid.get(`${ci + di},${cj + dj}`) || []) {
          const wi = segWay[id];
          const w = roadNameWays[wi];
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

    // Use the closest way, and check for ambiguous cases (other ways equally close).
    let bestWi = -1;
    let bestD = Infinity;
    for (const [wi, c] of nearest) {
      if (c.d < bestD) {
        bestD = c.d;
        bestWi = wi;
      }
    }

    // Check for ambiguity: another way with a significantly different name within the same distance.
    let ambiguous = false;
    for (const [wi, c] of nearest) {
      if (wi !== bestWi && c.d === bestD && roadNameWays[wi].name !== roadNameWays[bestWi].name) {
        ambiguous = true;
        break;
      }
    }

    if (ambiguous) {
      stats.ambiguous++;
      return;
    }

    stats.matched++;
    roadNames.push({ edge: ei, name: roadNameWays[bestWi].name });
  });

  return { roadNames, stats };
}

// Matches signposts to edges. Returns { signposts: [{ edge, signpost }], stats }.
export function matchSignposts(edges, signpostWays) {
  // Build a spatial index of signpost ways.
  const segWay = [];
  const segStart = [];
  const grid = new Map();
  signpostWays.forEach((w, wi) => {
    if (!w.geom || w.geom.length < 2) return;
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

  const signposts = [];
  const stats = { waysUsed: signpostWays.filter((w) => w.geom && w.geom.length >= 2).length, matched: 0, noWay: 0, ambiguous: 0 };

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

    // Find the nearest signpost way segment.
    const nearest = new Map(); // way index -> { d, aligned }
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const id of grid.get(`${ci + di},${cj + dj}`) || []) {
          const wi = segWay[id];
          const w = signpostWays[wi];
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

    // Use the closest way, and check for ambiguous cases (other ways equally close).
    let bestWi = -1;
    let bestD = Infinity;
    for (const [wi, c] of nearest) {
      if (c.d < bestD) {
        bestD = c.d;
        bestWi = wi;
      }
    }

    // Check for ambiguity: another way with a significantly different signpost within the same distance.
    let ambiguous = false;
    for (const [wi, c] of nearest) {
      if (wi !== bestWi && c.d === bestD && signpostWays[wi].signpost !== signpostWays[bestWi].signpost) {
        ambiguous = true;
        break;
      }
    }

    if (ambiguous) {
      stats.ambiguous++;
      return;
    }

    stats.matched++;
    signposts.push({ edge: ei, signpost: signpostWays[bestWi].signpost });
  });

  return { signposts, stats };
}
