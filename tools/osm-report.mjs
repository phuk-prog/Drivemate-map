// Reports how much OpenStreetMap detail the square files carry: names, speed limits, lanes,
// turn lanes and turn restrictions. Usage: node tools/osm-report.mjs
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDmap } from "./dmap.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "published", "squares");
const t = { files: 0, edges: 0, named: 0, maxspeed: 0, lanes: 0, turnLanes: 0, restrictions: 0, oneway: 0, roundabout: 0 };
const sampleNames = new Set();
for (const f of (await readdir(DIR)).filter((x) => x.endsWith(".dmap"))) {
  const m = readDmap(await readFile(join(DIR, f)));
  t.files++;
  t.restrictions += m.restrictions.length;
  for (const e of m.edges) {
    t.edges++;
    if (e.name) {
      t.named++;
      if (sampleNames.size < 8) sampleNames.add(m.strings[e.name]);
    }
    if (e.maxspeed) t.maxspeed++;
    if (e.lanes) t.lanes++;
    if (e.turnLanesFwd || e.turnLanesBwd) t.turnLanes++;
    if (e.flags & 1) t.oneway++;
    if (e.flags & 32) t.roundabout++;
  }
}
const pct = (n) => `${n} (${((100 * n) / Math.max(1, t.edges)).toFixed(1)}%)`;
console.log(`files ${t.files}, road edges ${t.edges}`);
console.log(`named ${pct(t.named)}, speed limit ${pct(t.maxspeed)}, lanes ${pct(t.lanes)}, turn lanes ${pct(t.turnLanes)}`);
console.log(`one-way ${pct(t.oneway)}, roundabout ${pct(t.roundabout)}, turn restrictions ${t.restrictions}`);
console.log(`sample names: ${[...sampleNames].join(", ")}`);
