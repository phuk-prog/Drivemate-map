// Loads the roads and turn restrictions for an area from an .osm.pbf extract, in two passes:
// first the roads and restrictions, then only the nodes those roads use. Our own code.

import { readPbfFile } from "./osmpbf.mjs";
import { roadClassOf } from "./osm-roads.mjs";

export function loadOsmRoads(pbfPath) {
  const ways = [];
  const relations = [];
  const needed = new Set();
  readPbfFile(pbfPath, {
    way: (w) => {
      if (!roadClassOf(w.tags)) return;
      ways.push(w);
      for (const n of w.nodes) needed.add(n);
    },
    relation: (r) => {
      if (r.tags.type === "restriction") relations.push(r);
    },
  });
  const coords = new Map();
  readPbfFile(pbfPath, {
    node: (n) => {
      if (needed.has(n.id)) coords.set(n.id, [n.lat, n.lon]);
    },
  });
  return { ways, relations, coords };
}
