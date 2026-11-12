// Builds Drivemate's road graph from raw OpenStreetMap data: real junctions, street names,
// speed limits, lanes, turn lanes and turn restrictions. Also reads fixed speed cameras. Our own code.
//
// Unlike the tile source, OSM gives every road its node ids, so a junction is simply a node
// shared by two or more roads. Roads are split at junctions into edges.

import { toFixed7 } from "./dmap.mjs";
import { LABEL_KIND } from "./classes.mjs";

// OSM highway values we route on, mapped to DMAP road classes (format/FORMAT.md).
const HIGHWAY_CLASS = {
  motorway: 1, motorway_link: 1,
  trunk: 2, trunk_link: 2,
  primary: 3, primary_link: 3,
  secondary: 4, secondary_link: 4,
  tertiary: 5, tertiary_link: 5,
  unclassified: 6, residential: 6, living_street: 6, road: 6,
  service: 7,
  track: 8,
};

export const EDGE_FLAG = {
  ONEWAY: 1,
  BRIDGE: 2,
  TUNNEL: 4,
  TOLL: 8,
  NO_MOTOR: 16,
  ROUNDABOUT: 32,
};

export const RESTRICTION_KIND = { NO: 1, ONLY: 2 };

export function roadClassOf(tags) {
  return HIGHWAY_CLASS[tags.highway] ?? 0;
}

// Speed limit in km/h, or 0 when unknown. Handles "50", "30 mph" and UK national limits.
export function parseMaxspeed(value) {
  if (!value) return 0;
  const v = String(value).trim().toLowerCase();
  const named = {
    "gb:nsl_single": 96, // 60 mph
    "gb:nsl_dual": 112, // 70 mph
    "gb:motorway": 112, // 70 mph
    "uk:nsl_single": 96,
    "uk:nsl_dual": 112,
    "uk:motorway": 112,
  };
  if (named[v] !== undefined) return named[v];
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const kmh = m[2] === "mph" ? n * 1.609344 : n;
  return Math.max(0, Math.min(255, Math.round(kmh)));
}

// Compass direction in whole degrees (0 to 359) from a numeric direction tag, or -1 when the tag
// is missing or not a number (for example "forward" or "90-270").
export function parseDirection(value) {
  if (value === undefined || value === null) return -1;
  const v = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(v)) return -1;
  return ((Math.round(Number(v)) % 360) + 360) % 360;
}

// A fixed speed camera node: highway=speed_camera.
export function isSpeedCamera(tags) {
  return tags?.highway === "speed_camera";
}

// Node ids of the camera devices in an enforcement relation (type=enforcement,
// enforcement=maxspeed, members with role "device"). Other relations give none.
export function enforcementDevices(relation) {
  const t = relation.tags;
  if (t.type !== "enforcement" || t.enforcement !== "maxspeed") return [];
  return relation.members.filter((m) => m.role === "device" && m.type === "node").map((m) => m.ref);
}

// node: { lat, lon, tags }. relationTags (optional): tags of the enforcement relation that names
// it. Returns { lat, lon, maxspeed (km/h, 0 unknown), direction (degrees, -1 unknown) }.
export function speedCameraOf(node, relationTags = null) {
  const tags = node.tags ?? {};
  return {
    lat: node.lat,
    lon: node.lon,
    maxspeed: parseMaxspeed(tags.maxspeed) || parseMaxspeed(relationTags?.maxspeed),
    direction: parseDirection(tags.direction ?? tags["camera:direction"]),
  };
}

// Speed cameras inside bbox ([minLon, minLat, maxLon, maxLat]) as DMAP labels of kind 7:
// category = speed limit in km/h (0 unknown), name = direction in degrees as text ("" unknown).
// A camera listed twice at the same point (node tag and enforcement relation) is kept once.
export function speedCameraLabels(cameras = [], bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const seen = new Set();
  const labels = [];
  for (const c of cameras) {
    if (!(c.lat >= minLat && c.lat <= maxLat && c.lon >= minLon && c.lon <= maxLon)) continue;
    const label = {
      kind: LABEL_KIND.speedCamera,
      category: Math.max(0, Math.min(255, Math.round(c.maxspeed || 0))),
      lat: toFixed7(c.lat),
      lon: toFixed7(c.lon),
      name: c.direction >= 0 ? String(c.direction) : "",
    };
    const key = `${label.lat}|${label.lon}|${label.category}|${label.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

// Direction of travel: 1 forward only, -1 reverse only, 0 both ways.
export function onewayOf(tags) {
  const o = (tags.oneway ?? "").toLowerCase();
  if (o === "yes" || o === "true" || o === "1") return 1;
  if (o === "-1" || o === "reverse") return -1;
  if (o === "no" || o === "false" || o === "0") return 0;
  if (tags.junction === "roundabout" || tags.junction === "circular") return 1;
  if (tags.highway === "motorway" || tags.highway === "motorway_link") return 1;
  return 0;
}

function flagsOf(tags, oneway) {
  let flags = 0;
  if (oneway !== 0) flags |= EDGE_FLAG.ONEWAY;
  if (tags.bridge && tags.bridge !== "no") flags |= EDGE_FLAG.BRIDGE;
  if (tags.tunnel && tags.tunnel !== "no") flags |= EDGE_FLAG.TUNNEL;
  if (tags.toll === "yes") flags |= EDGE_FLAG.TOLL;
  const access = tags.motor_vehicle ?? tags.motorcar ?? tags.vehicle ?? tags.access;
  if (access === "no" || access === "private") flags |= EDGE_FLAG.NO_MOTOR;
  if (tags.junction === "roundabout" || tags.junction === "circular") flags |= EDGE_FLAG.ROUNDABOUT;
  return flags;
}

// Interns strings so each name is stored once. Index 0 is the empty string ("none").
class StringTable {
  constructor() {
    this.list = [""];
    this.index = new Map([["", 0]]);
  }
  id(s) {
    if (!s) return 0;
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(s);
      this.index.set(s, i);
    }
    return i;
  }
}

// ways: [{ id, tags, nodes: [osm node ids] }] (roads only)
// coords: Map osm node id -> [lat, lon] in degrees
// relations: [{ id, tags, members: [{ type, ref, role }] }] (restrictions only)
// bbox: [minLon, minLat, maxLon, maxLat]. A road is kept if any of its nodes is inside.
// Returns { nodes, edges, restrictions, strings } ready for writeDmap.
export function buildRoadGraph({ ways, coords, relations = [], bbox }) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const inside = (c) => c && c[0] >= minLat && c[0] <= maxLat && c[1] >= minLon && c[1] <= maxLon;

  // 1. Keep roads that are routable, fully located, and touch the area.
  const kept = [];
  for (const w of ways) {
    const roadClass = roadClassOf(w.tags);
    if (!roadClass || w.nodes.length < 2) continue;
    if (!w.nodes.every((n) => coords.has(n))) continue;
    if (!w.nodes.some((n) => inside(coords.get(n)))) continue;
    kept.push({ ...w, roadClass });
  }

  // 2. A node used by two or more roads (or twice by one road) is a junction. Road ends are too.
  const uses = new Map();
  for (const w of kept) for (const n of w.nodes) uses.set(n, (uses.get(n) ?? 0) + 1);
  const isJunction = (w, i) => i === 0 || i === w.nodes.length - 1 || uses.get(w.nodes[i]) > 1;

  // 3. Split each road at junctions into edges. Graph node ids are compact indices.
  const strings = new StringTable();
  const nodeIndex = new Map();
  const nodes = [];
  const nodeId = (osmId) => {
    let i = nodeIndex.get(osmId);
    if (i === undefined) {
      i = nodes.length;
      const [lat, lon] = coords.get(osmId);
      nodes.push({ lat: toFixed7(lat), lon: toFixed7(lon), osmId });
      nodeIndex.set(osmId, i);
    }
    return i;
  };

  const edges = [];
  const edgesOfWay = new Map(); // way id -> [{ edge index, first osm node, last osm node }]
  for (const w of kept) {
    const oneway = onewayOf(w.tags);
    const flags = flagsOf(w.tags, oneway);
    const name = strings.id(w.tags.name ?? "");
    const ref = strings.id(w.tags.ref ?? "");
    const maxspeed = parseMaxspeed(w.tags.maxspeed);
    const lanes = Math.min(255, Number.parseInt(w.tags.lanes ?? "0", 10) || 0);
    // Turn lanes in the direction of the stored points (forward), and against it (backward).
    let turnFwd = w.tags["turn:lanes:forward"] ?? (oneway === 1 ? w.tags["turn:lanes"] : undefined);
    let turnBwd = w.tags["turn:lanes:backward"] ?? (oneway === -1 ? w.tags["turn:lanes"] : undefined);

    // Reverse one-way roads are stored in their travel direction.
    let seq = w.nodes;
    if (oneway === -1) {
      seq = [...w.nodes].reverse();
      [turnFwd, turnBwd] = [turnBwd, turnFwd];
    }

    const list = [];
    let start = 0;
    for (let i = 1; i < seq.length; i++) {
      if (!isJunction({ nodes: seq }, i)) continue;
      const part = seq.slice(start, i + 1);
      const from = nodeId(part[0]);
      const to = nodeId(part[part.length - 1]);
      if (from !== to || part.length > 2) {
        const idx = edges.length;
        edges.push({
          from,
          to,
          roadClass: w.roadClass,
          flags,
          maxspeed,
          lanes,
          name,
          ref,
          turnLanesFwd: strings.id(turnFwd ?? ""),
          turnLanesBwd: strings.id(turnBwd ?? ""),
          points: part.map((n) => {
            const [lat, lon] = coords.get(n);
            return [toFixed7(lat), toFixed7(lon)];
          }),
        });
        list.push({ edge: idx, first: part[0], last: part[part.length - 1] });
      }
      start = i;
    }
    edgesOfWay.set(w.id, list);
  }

  // 4. Turn restrictions: from a road, through a junction node, to a road.
  const restrictions = [];
  for (const r of relations) {
    if (r.tags.type !== "restriction") continue;
    const value = r.tags.restriction ?? r.tags["restriction:motorcar"];
    if (!value) continue;
    const kind = value.startsWith("only_") ? RESTRICTION_KIND.ONLY : value.startsWith("no_") ? RESTRICTION_KIND.NO : 0;
    if (!kind) continue;
    const from = r.members.find((m) => m.role === "from" && m.type === "way");
    const via = r.members.find((m) => m.role === "via" && m.type === "node");
    const to = r.members.find((m) => m.role === "to" && m.type === "way");
    if (!from || !via || !to) continue; // via-way restrictions are not supported yet
    const viaNode = nodeIndex.get(via.ref);
    if (viaNode === undefined) continue;
    const touching = (wayId) => (edgesOfWay.get(wayId) ?? []).find((e) => e.first === via.ref || e.last === via.ref);
    const fromEdge = touching(from.ref);
    const toEdge = touching(to.ref);
    if (!fromEdge || !toEdge) continue;
    restrictions.push({ fromEdge: fromEdge.edge, viaNode, toEdge: toEdge.edge, kind });
  }

  return { nodes, edges, restrictions, strings: strings.list };
}
