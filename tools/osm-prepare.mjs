// Downloads a Geofabrik extract and writes the restriction, lane and warning caches that the map
// builder reads (data/osm-cache/*/<name>.json). Build-time only. Used by tools/update-regions.mjs.
// Usage: node tools/osm-prepare.mjs --geofabrik=greater-london --name=london --bbox=minLon,minLat,maxLon,maxLat

import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// bbox is [minLon, minLat, maxLon, maxLat]. Removes the large .pbf afterwards.
export async function prepareOsm({ geofabrik, name, bbox, log = console.log }) {
  const dir = join(ROOT, "data", "osm-src");
  await mkdir(dir, { recursive: true });
  const pbf = join(dir, `${geofabrik}.osm.pbf`);
  const url = execFileSync("node", [join(ROOT, "tools", "geofabrik-url.mjs"), geofabrik], { encoding: "utf8" }).trim();
  log(`${name}: downloading ${url}`);
  execFileSync("curl", ["-fL", "--retry", "5", "--retry-all-errors", "--retry-delay", "10", "-o", pbf, url], { stdio: "inherit" });
  log(`${name}: extracting restrictions, lanes and warnings`);
  execFileSync(
    "node",
    ["--max-old-space-size=6000", join(ROOT, "tools", "osm-extract.mjs"), `--pbf=${pbf}`, `--name=${name}`, `--bbox=${bbox.join(",")}`],
    { stdio: "inherit" },
  );
  await rm(pbf, { force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : undefined;
  };
  await prepareOsm({ geofabrik: arg("geofabrik"), name: arg("name"), bbox: arg("bbox").split(",").map(Number) });
}
