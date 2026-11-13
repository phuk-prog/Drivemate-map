// Fetches OpenStreetMap lane tags (turn:lanes) for a bounding box from the Overpass API,
// and caches the parsed ways in data/osm-cache/lanes/<name>.json (not committed).
// Build-time only: the app never calls Overpass.
// Usage: node tools/fetch-lanes.mjs --name=london --bbox=-0.55,51.28,0.30,51.70

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLaneOverpass } from "./lanes.mjs";
import { fetchOverpass, overpassBox } from "./overpass.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function overpassQuery(bbox) {
  const box = overpassBox(bbox);
  return `[out:json][timeout:900];
(
  way["highway"]["turn:lanes"]${box};
  way["highway"]["turn:lanes:forward"]${box};
  way["highway"]["turn:lanes:backward"]${box};
);
out geom tags;`;
}

async function main() {
  const arg = (n, def) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : def;
  };
  const name = arg("name", "london");
  const bbox = arg("bbox", "-0.55,51.28,0.30,51.70").split(",").map(Number);
  const started = Date.now();
  const json = await fetchOverpass(overpassQuery(bbox));
  const { ways, skipped } = parseLaneOverpass(json);
  const outDir = join(ROOT, "data", "osm-cache", "lanes");
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `${name}.json`);
  await writeFile(outFile, JSON.stringify(ways));
  console.log(JSON.stringify({ name, bbox, elements: json.elements?.length ?? 0, usableWays: ways.length, skipped, outFile }, null, 2));
  console.log(`fetched in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
