// Loads the roads, turn restrictions and fixed speed cameras for an area from an .osm.pbf
// extract. Our own code.
//
// Memory stays bounded for very large extracts (Scotland, Ireland): no Map or Set ever holds one
// entry per node (a Map holds at most about 16.7 million), node ids and coordinates are kept in
// typed arrays (see coord-store.mjs), and with a bbox only the roads that touch it are kept,
// with the coordinates of their nodes only:
//   1. every block: the road ways (their node ids go into one sorted id list; the ways
//      themselves are kept only without a bbox), restrictions and speed camera relations;
//   2. node blocks only: which road nodes lie inside the bbox (one byte per road node), and
//      the speed cameras inside it;
//   3. way blocks only: the roads with a node inside the bbox, and every node they use;
//   4. node blocks only: the coordinates of those nodes.
// Small extracts (up to fullStoreLimit road nodes) keep every road node's coordinates in pass 2
// and skip pass 4. A pass reads only the blocks it needs: the first pass notes which blocks hold
// nodes and which hold ways, and later passes never inflate the others.
//
// A very large area is then built in batches of squares: batch(bbox) re-reads the way blocks
// that hold the area's roads and returns only the roads touching that smaller bbox, so only one
// batch of road objects is in memory at a time. Every square inside a batch's bbox gets exactly
// the roads it would get from the whole extract.

import { readPbfFile, BLOCK_NODES, BLOCK_WAYS } from "./osmpbf.mjs";
import { roadClassOf, isSpeedCamera, speedCameraOf, enforcementDevices } from "./osm-roads.mjs";
import { CoordStore, IdList, indexOfSorted, BYTES_PER_NODE } from "./coord-store.mjs";

export const FULL_STORE_LIMIT = 4_000_000; // road nodes; 96 MB of coordinates

// bbox: [minLon, minLat, maxLon, maxLat]. Edges count as inside (as in buildRoadGraph).
export const insideBbox = (bbox, lat, lon) => lat >= bbox[1] && lat <= bbox[3] && lon >= bbox[0] && lon <= bbox[2];
export const bboxContains = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];

// Restrictions whose via node is in coords (all of them without coords).
const restrictionsAt = (relations, coords) => relations.filter((r) => r.members.some((m) => m.type === "node" && m.role === "via" && coords.has(m.ref)));

// Prepares an extract for an area. bbox: the area ([minLon, minLat, maxLon, maxLat]), or null
// for the whole extract. keepWays: keep the area's road objects (false for an area built in
// batches; batch() then reads them per batch).
// Returns { roads, batch(bbox), stats }. roads ({ ways, relations, coords, cameras }) is null
// when keepWays is false.
export function openOsmRoads(pbfPath, { bbox = null, keepWays = true, fullStoreLimit = FULL_STORE_LIMIT } = {}) {
  // Pass 1: road ways, restrictions, camera relations.
  const refs = new IdList(1 << 16);
  const restrictions = [];
  const devices = new Map(); // camera node id -> tags of the enforcement relation naming it
  let ways = !bbox && keepWays ? [] : null;
  let roadWays = 0;
  const blocks = readPbfFile(pbfPath, {
    way: (w) => {
      if (!roadClassOf(w.tags)) return;
      roadWays++;
      for (const n of w.nodes) refs.push(n);
      if (ways) ways.push(w);
    },
    relation: (r) => {
      if (r.tags.type === "restriction") restrictions.push(r);
      for (const id of enforcementDevices(r)) if (!devices.has(id)) devices.set(id, r.tags);
    },
  });
  const nodeBlocks = blocks.filter((b) => b.kinds & BLOCK_NODES);
  let wayBlocks = blocks.filter((b) => b.kinds & BLOCK_WAYS);
  const needed = refs.finish(); // every road node id, sorted, once
  const full = !bbox || needed.length <= fullStoreLimit;

  // Pass 2: which road nodes are inside the bbox (or, when small enough, all their coordinates),
  // and the speed cameras.
  const cameras = [];
  const inside = bbox ? new Uint8Array(needed.length) : null;
  let lats = full ? new Float64Array(needed.length).fill(NaN) : null;
  let lons = full ? new Float64Array(needed.length) : null;
  readPbfFile(pbfPath, {
    coord: (id, lat, lon, tagged) => {
      const i = indexOfSorted(needed, id);
      if (i >= 0) {
        if (full) {
          lats[i] = lat;
          lons[i] = lon;
        }
        if (inside && insideBbox(bbox, lat, lon)) inside[i] = 1;
      }
      if (!tagged && devices.has(id) && (!bbox || insideBbox(bbox, lat, lon))) cameras.push(speedCameraOf({ lat, lon, tags: {} }, devices.get(id)));
    },
    taggedNode: (n) => {
      const relTags = devices.get(n.id);
      if ((relTags || isSpeedCamera(n.tags)) && (!bbox || insideBbox(bbox, n.lat, n.lon))) cameras.push(speedCameraOf(n, relTags));
    },
  }, { blocks: nodeBlocks });

  // The road nodes found, as a store (nodes a road names but the extract lacks are left out).
  const storeOf = (ids, la, lo) => {
    let n = 0;
    for (let i = 0; i < ids.length; i++) if (!Number.isNaN(la[i])) n++;
    if (n === ids.length) return new CoordStore(ids, la, lo);
    const out = new CoordStore(new Float64Array(n), new Float64Array(n), new Float64Array(n));
    for (let i = 0, k = 0; i < ids.length; i++) {
      if (Number.isNaN(la[i])) continue;
      out.ids[k] = ids[i];
      out.lats[k] = la[i];
      out.lons[k] = lo[i];
      k++;
    }
    return out;
  };

  let coords;
  if (!bbox) {
    coords = storeOf(needed, lats, lons);
  } else {
    // Pass 3: the roads with a node inside the bbox, and the nodes they use.
    const keep = new Uint8Array(needed.length);
    if (keepWays) ways = [];
    const hit = [];
    let found = false;
    readPbfFile(pbfPath, {
      way: (w) => {
        if (!roadClassOf(w.tags)) return;
        const idx = w.nodes.map((n) => indexOfSorted(needed, n));
        if (!idx.some((i) => inside[i] === 1)) return;
        for (const i of idx) keep[i] = 1;
        if (ways) ways.push(w);
        found = true;
      },
      block: (b) => {
        if (found) hit.push(b);
        found = false;
      },
    }, { blocks: wayBlocks });
    wayBlocks = hit; // batches read only the way blocks that hold the area's roads
    let m = 0;
    for (let i = 0; i < keep.length; i++) if (keep[i]) m++;
    const ids = new Float64Array(m);
    for (let i = 0, k = 0; i < keep.length; i++) if (keep[i]) ids[k++] = needed[i];
    if (full) {
      const la = new Float64Array(m);
      const lo = new Float64Array(m);
      for (let i = 0, k = 0; i < keep.length; i++) {
        if (!keep[i]) continue;
        la[k] = lats[i];
        lo[k] = lons[i];
        k++;
      }
      coords = storeOf(ids, la, lo);
    } else {
      // Pass 4: the coordinates of those nodes only.
      const la = new Float64Array(m).fill(NaN);
      const lo = new Float64Array(m);
      readPbfFile(pbfPath, {
        coord: (id, lat, lon) => {
          const k = indexOfSorted(ids, id);
          if (k >= 0) {
            la[k] = lat;
            lo[k] = lon;
          }
        },
      }, { blocks: nodeBlocks });
      coords = storeOf(ids, la, lo);
    }
  }
  lats = lons = null;
  const relations = bbox ? restrictionsAt(restrictions, coords) : restrictions;
  const stats = {
    roadWays,
    roadNodes: needed.length,
    areaWays: ways ? ways.length : null,
    areaNodes: coords.size,
    coordBytes: coords.byteLength,
    peakIdBytes: needed.length * BYTES_PER_NODE,
    blocks: blocks.length,
    areaWayBlocks: wayBlocks.length,
  };
  const roads = ways ? { ways, relations, coords, cameras } : null;

  // The roads touching a bbox inside the area: those of `roads` when it covers the whole area,
  // otherwise read again from the way blocks that hold area roads.
  function batch(box) {
    if (roads && (!bbox || bboxContains(box, bbox))) return roads;
    const kept = [];
    const ids = new IdList(1 << 12);
    readPbfFile(pbfPath, {
      way: (w) => {
        if (!roadClassOf(w.tags)) return;
        let touches = false;
        for (const n of w.nodes) {
          const i = coords.indexOf(n);
          if (i >= 0 && insideBbox(box, coords.lats[i], coords.lons[i])) {
            touches = true;
            break;
          }
        }
        if (!touches) return;
        kept.push(w);
        for (const n of w.nodes) if (coords.indexOf(n) >= 0) ids.push(n);
      },
    }, { blocks: wayBlocks });
    const part = coords.pick(ids.finish());
    return {
      ways: kept,
      relations: restrictionsAt(relations, part),
      coords: part,
      cameras: cameras.filter((c) => insideBbox(box, c.lat, c.lon)),
    };
  }

  return { roads, batch, stats };
}

// The roads of an extract: all of them, or (with bbox) those with a node inside bbox, with every
// node they use, the restrictions at those nodes and the cameras inside bbox.
// Returns { ways, relations, coords (a CoordStore), cameras }.
export function loadOsmRoads(pbfPath, { bbox = null } = {}) {
  return openOsmRoads(pbfPath, { bbox, keepWays: true }).roads;
}
