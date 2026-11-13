// Integrity checker for DMAP map files (see format/FORMAT.md). The app trusts the file, so a bad
// file would break routing. validateDmap(map) takes the object readDmap returns and gives back a
// list of problem strings (empty list = valid). Unknown extra fields on the map are ignored.
// Our own code. No third-party dependencies.
//
// Usage: node tools/validate-dmap.mjs <file.dmap>      (exit code 1 and the problems on failure)
//
// Thresholds (units are 1e-7 degrees, 1 unit is about 1.1 cm in latitude):
//   EDGE_END_TOLERANCE 220  an edge's first/last point must be within this of its node, on each axis.
//                           The builder snaps nodes with SNAP = 200 (about 2.2 m); 20 extra units
//                           (about 22 cm) absorb rounding. 220 units is about 2.4 m, inside 2.5 m.
//   POINT_MARGIN 500000     road and area points may lie this far (about 5 km) outside the bbox,
//                           because map tiles reach past the requested box.
//   WARNING_MARGIN 50000    warnings come from the OSM extract of the bbox itself, so only about
//                           550 m of slack is allowed.
//   Lane count 1..12        a road with more than 12 lanes in one direction is not plausible.
//   Speed limit 5..130      in the unit the record says (0 km/h, 1 mph).
// Memory: the checker holds only the parsed map plus small Sets/typed arrays; it does one pass
// per section and reports at most MAX_SAMPLES examples per kind of problem.

const EDGE_END_TOLERANCE = 220;
const POINT_MARGIN = 500000;
const WARNING_MARGIN = 50000;
const MAX_LANES = 12;
const MAX_SAMPLES = 5;
const LAT_LIMIT = 900000000;
const LON_LIMIT = 1800000000;
const FLAG_ONEWAY = 1;

// Values of the OSM turn:lanes vocabulary. An empty lane means "none".
const LANE_VALUES = new Set([
  "none", "through", "left", "slight_left", "sharp_left", "right", "slight_right", "sharp_right",
  "reverse", "merge_to_left", "merge_to_right", "reversible",
]);

// Returns null if the lane text is valid, otherwise a short reason.
export function laneTextProblem(text) {
  if (typeof text !== "string" || text.length === 0) return "empty text";
  const lanes = text.split("|");
  if (lanes.length < 1 || lanes.length > MAX_LANES) return `${lanes.length} lanes (allowed 1 to ${MAX_LANES})`;
  for (const lane of lanes) {
    if (lane === "") continue; // an empty lane means none
    for (const v of lane.split(";")) {
      if (!LANE_VALUES.has(v)) return `unknown lane value "${v.slice(0, 30)}"`;
    }
  }
  return null;
}

class Problems {
  constructor() {
    this.kinds = new Map();
  }

  add(kind, detail) {
    let k = this.kinds.get(kind);
    if (!k) this.kinds.set(kind, (k = { count: 0, samples: [] }));
    k.count++;
    if (k.samples.length < MAX_SAMPLES) k.samples.push(detail);
  }

  list() {
    const out = [];
    for (const [kind, { count, samples }] of this.kinds) {
      out.push(`${kind}: ${count} problem(s), e.g. ${samples.join("; ")}`);
    }
    return out;
  }
}

const isId = (v, n) => Number.isInteger(v) && v >= 0 && v < n;

export function validateDmap(map) {
  const P = new Problems();
  if (!map || typeof map !== "object") return ["map is not an object"];
  const nodes = map.nodes ?? [];
  const edges = map.edges ?? [];
  const lines = map.lines ?? [];
  const polygons = map.polygons ?? [];
  const labels = map.labels ?? [];
  const restrictions = map.restrictions ?? [];
  const lanes = map.lanes ?? [];
  const warnings = map.warnings ?? [];

  // Bounding box.
  const bbox = map.bbox;
  let bboxOk = false;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) {
    P.add("bbox", "not four numbers");
  } else {
    const [minLat, minLon, maxLat, maxLon] = bbox;
    if (!(minLat < maxLat && minLon < maxLon)) P.add("bbox", "empty or inverted");
    else if (minLat < -LAT_LIMIT || maxLat > LAT_LIMIT || minLon < -LON_LIMIT || maxLon > LON_LIMIT) P.add("bbox", "out of range");
    else bboxOk = true;
  }
  const outside = (lat, lon, m) =>
    bboxOk && (lat < bbox[0] - m || lat > bbox[2] + m || lon < bbox[1] - m || lon > bbox[3] + m);
  const badCoord = (lat, lon) =>
    !Number.isInteger(lat) || !Number.isInteger(lon) || Math.abs(lat) > LAT_LIMIT || Math.abs(lon) > LON_LIMIT;

  // Nodes.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (badCoord(n.lat, n.lon)) P.add("node coordinates", `node ${i}`);
  }

  // Edges.
  const edgeCount = edges.length;
  for (let i = 0; i < edgeCount; i++) {
    const e = edges[i];
    const pts = e.points;
    const fromOk = isId(e.from, nodes.length);
    const toOk = isId(e.to, nodes.length);
    if (!fromOk || !toOk) P.add("edge node id", `edge ${i} from ${e.from} to ${e.to} (${nodes.length} nodes)`);
    if (!Number.isInteger(e.roadClass) || e.roadClass < 1 || e.roadClass > 8) P.add("road class", `edge ${i} class ${e.roadClass}`);
    if (!pts || pts.length < 2) {
      P.add("edge points", `edge ${i} has ${pts ? pts.length : 0} point(s)`);
      continue;
    }
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      if (badCoord(p[0], p[1])) {
        P.add("edge point coordinates", `edge ${i} point ${k}`);
        break;
      }
    }
    if (outside(pts[0][0], pts[0][1], POINT_MARGIN) || outside(pts[pts.length - 1][0], pts[pts.length - 1][1], POINT_MARGIN)) {
      P.add("edge outside bbox", `edge ${i}`);
    }
    if (fromOk) {
      const a = pts[0];
      const n = nodes[e.from];
      if (Math.abs(a[0] - n.lat) > EDGE_END_TOLERANCE || Math.abs(a[1] - n.lon) > EDGE_END_TOLERANCE) {
        P.add("edge start far from its node", `edge ${i} node ${e.from}`);
      }
    }
    if (toOk) {
      const a = pts[pts.length - 1];
      const n = nodes[e.to];
      if (Math.abs(a[0] - n.lat) > EDGE_END_TOLERANCE || Math.abs(a[1] - n.lon) > EDGE_END_TOLERANCE) {
        P.add("edge end far from its node", `edge ${i} node ${e.to}`);
      }
    }
  }

  // Lines.
  for (let i = 0; i < lines.length; i++) {
    const pts = lines[i].points;
    if (!pts || pts.length < 2) P.add("line points", `line ${i} has ${pts ? pts.length : 0} point(s)`);
  }

  // Polygons: every ring closed (first = last) or at least 3 points; and always at least 3 points.
  for (let i = 0; i < polygons.length; i++) {
    const rings = polygons[i].rings;
    if (!rings || rings.length === 0) {
      P.add("polygon rings", `polygon ${i} has no rings`);
      continue;
    }
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      if (ring.length < 3) {
        P.add("polygon ring", `polygon ${i} ring ${r} has ${ring.length} point(s)`);
        continue;
      }
      if (outside(ring[0][0], ring[0][1], POINT_MARGIN)) P.add("polygon outside bbox", `polygon ${i}`);
    }
  }

  // Labels.
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (typeof l.name !== "string" || l.name.length === 0) P.add("label name", `label ${i} is empty`);
    if (badCoord(l.lat, l.lon)) P.add("label coordinates", `label ${i}`);
  }

  // Restrictions.
  const seenRestriction = new Set();
  for (let i = 0; i < restrictions.length; i++) {
    const r = restrictions[i];
    if (r.kind !== 1 && r.kind !== 2) P.add("restriction kind", `restriction ${i} kind ${r.kind}`);
    const fOk = isId(r.from, edgeCount);
    const tOk = isId(r.to, edgeCount);
    const vOk = isId(r.via, nodes.length);
    if (!fOk || !tOk) P.add("restriction edge id", `restriction ${i} from ${r.from} to ${r.to} (${edgeCount} edges)`);
    if (!vOk) P.add("restriction via node", `restriction ${i} via ${r.via} (${nodes.length} nodes)`);
    if (fOk && tOk && r.from === r.to) P.add("restriction from equals to", `restriction ${i} edge ${r.from}`);
    if (fOk && tOk && vOk) {
      const a = edges[r.from];
      const b = edges[r.to];
      const aOne = (a.flags & FLAG_ONEWAY) !== 0;
      const bOne = (b.flags & FLAG_ONEWAY) !== 0;
      // The traveller arrives on `from` at via (its end, or its start if two-way) and leaves on `to` from via.
      const arrives = a.to === r.via || (!aOne && a.from === r.via);
      const leaves = b.from === r.via || (!bOne && b.to === r.via);
      if (!arrives) P.add("restriction from-edge does not end at via", `restriction ${i} edge ${r.from} via ${r.via}`);
      if (!leaves) P.add("restriction to-edge does not start at via", `restriction ${i} edge ${r.to} via ${r.via}`);
    }
    const key = `${r.kind}/${r.from}/${r.to}/${r.via}`;
    if (seenRestriction.has(key)) P.add("duplicate restriction", `restriction ${i} (${key})`);
    else seenRestriction.add(key);
  }

  // Lanes.
  const seenLane = new Set();
  for (let i = 0; i < lanes.length; i++) {
    const l = lanes[i];
    if (!isId(l.edge, edgeCount)) P.add("lane edge id", `lane record ${i} edge ${l.edge} (${edgeCount} edges)`);
    else if (seenLane.has(l.edge)) P.add("duplicate lane record", `edge ${l.edge}`);
    else seenLane.add(l.edge);
    const why = laneTextProblem(l.text);
    if (why) P.add("lane text", `lane record ${i} edge ${l.edge} "${String(l.text).slice(0, 40)}": ${why}`);
  }

  // Warnings.
  for (let i = 0; i < warnings.length; i++) {
    const w = warnings[i];
    if (!Number.isInteger(w.kind) || w.kind < 1 || w.kind > 3) P.add("warning kind", `warning ${i} kind ${w.kind}`);
    if (badCoord(w.lat, w.lon)) P.add("warning coordinates", `warning ${i}`);
    else if (outside(w.lat, w.lon, WARNING_MARGIN)) P.add("warning outside bbox", `warning ${i} kind ${w.kind} at ${w.lat},${w.lon}`);
  }

  // Speed limits (map format version 7), validated only if present.
  if (map.speedLimits !== undefined && map.speedLimits !== null) {
    if (!Array.isArray(map.speedLimits)) {
      P.add("speed limits", "not a list");
    } else {
      const seen = new Set();
      for (let i = 0; i < map.speedLimits.length; i++) {
        const s = map.speedLimits[i];
        if (!isId(s.edge, edgeCount)) P.add("speed limit edge id", `record ${i} edge ${s.edge} (${edgeCount} edges)`);
        else if (seen.has(s.edge)) P.add("duplicate speed limit", `edge ${s.edge}`);
        else seen.add(s.edge);
        if (s.unit !== 0 && s.unit !== 1) P.add("speed limit unit", `record ${i} unit ${s.unit}`);
        if (!Number.isInteger(s.value) || s.value < 5 || s.value > 130) P.add("speed limit value", `record ${i} value ${s.value}`);
      }
    }
  }

  return P.list();
}

// Command line.
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node tools/validate-dmap.mjs <file.dmap>");
    process.exit(2);
  }
  const { readFile } = await import("node:fs/promises");
  const { readDmap } = await import("./dmap.mjs");
  const t0 = Date.now();
  let map;
  try {
    map = readDmap(await readFile(file));
  } catch (err) {
    console.error(`${file}: does not decode: ${err.message}`);
    process.exit(1);
  }
  const problems = validateDmap(map);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const sizes = `${map.nodes.length} nodes, ${map.edges.length} edges, ${map.restrictions.length} restrictions, ${map.lanes.length} lanes, ${map.warnings.length} warnings`;
  if (problems.length) {
    console.error(`${file}: INVALID (${sizes}, ${secs}s)\n  ` + problems.join("\n  "));
    process.exit(1);
  }
  console.log(`${file}: valid (${sizes}, ${secs}s)`);
}
