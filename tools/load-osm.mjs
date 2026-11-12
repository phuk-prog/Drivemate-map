// Loads the roads, turn restrictions and fixed speed cameras for an area from an .osm.pbf
// extract, in two passes: first the roads and relations, then the nodes (the ones those roads
// use, plus speed cameras). Our own code.

import { readPbfFile } from "./osmpbf.mjs";
import { roadClassOf, isSpeedCamera, speedCameraOf, enforcementDevices } from "./osm-roads.mjs";

export function loadOsmRoads(pbfPath) {
  const ways = [];
  const relations = [];
  const needed = new Set();
  // Camera nodes named by enforcement relations: node id -> the relation's tags.
  const devices = new Map();
  readPbfFile(pbfPath, {
    way: (w) => {
      if (!roadClassOf(w.tags)) return;
      ways.push(w);
      for (const n of w.nodes) needed.add(n);
    },
    relation: (r) => {
      if (r.tags.type === "restriction") relations.push(r);
      for (const id of enforcementDevices(r)) if (!devices.has(id)) devices.set(id, r.tags);
    },
  });
  const coords = new Map();
  const cameras = [];
  readPbfFile(pbfPath, {
    node: (n) => {
      if (needed.has(n.id)) coords.set(n.id, [n.lat, n.lon]);
      const relTags = devices.get(n.id);
      if (relTags || isSpeedCamera(n.tags)) cameras.push(speedCameraOf(n, relTags));
    },
  });
  return { ways, relations, coords, cameras };
}
