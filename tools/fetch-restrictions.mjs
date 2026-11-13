// Fetches OpenStreetMap turn restrictions for a bounding box from the Overpass API,
// and caches them (parsed) in data/cache/restrictions/<name>.json (not committed).
// Build-time only: the app never calls Overpass.
// Usage: node tools/fetch-restrictions.mjs --name=london --bbox=-0.55,51.28,0.30,51.70

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOverpass } from "./restrictions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Overpass bounding boxes are (south, west, north, east).
export function overpassQuery([minLon, minLat, maxLon, maxLat]) {
  return `[out:json][timeout:900];
relation["type"="restriction"](${minLat},${minLon},${maxLat},${maxLon});
out geom;`;
}

export async function fetchRestrictionJson(bbox) {
  const query = overpassQuery(bbox);
  let lastError = null;
  for (const url of ENDPOINTS) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: query }),
        });
        if (res.status === 429) {
          // Overpass is busy. Wait longer before trying again.
          lastError = new Error(`HTTP 429 from ${url}`);
          await new Promise((r) => setTimeout(r, 60000 * attempt));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
  }
  throw new Error(`Overpass request failed: ${lastError?.message}`);
}

async function main() {
  const arg = (n, def) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : def;
  };
  const name = arg("name", "london");
  const bbox = arg("bbox", "-0.55,51.28,0.30,51.70").split(",").map(Number);
  const started = Date.now();
  const json = await fetchRestrictionJson(bbox);
  const { records, skipped } = parseOverpass(json);
  const outDir = join(ROOT, "data", "cache", "restrictions");
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `${name}.json`);
  await writeFile(outFile, JSON.stringify(records));
  console.log(JSON.stringify({ name, bbox, relations: json.elements?.length ?? 0, usable: records.length, skipped, outFile }, null, 2));
  console.log(`fetched in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
