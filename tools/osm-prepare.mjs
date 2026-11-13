// Downloads a Geofabrik extract and writes the restriction, lane and warning caches that the map
// builder reads (data/osm-cache/*/<name>.json). Build-time only. Used by tools/update-regions.mjs.
// For a large extract (the map growing outwards), the caches are also split into 1° blocks.
// Usage: node tools/osm-prepare.mjs --geofabrik=greater-london --name=london --bbox=minLon,minLat,maxLon,maxLat

import { execFileSync } from "node:child_process";
import { mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "data", "osm-cache");
const KINDS = ["restrictions", "lanes", "warnings", "speed"];
// A record within this many degrees (about 1.1 km north-south) of a block's edge also goes into the next block,
// so a square at the edge of its block still sees every record near its roads.
const BLOCK_MARGIN = 0.01;

// The .osm.pbf download address of a Geofabrik extract, from Geofabrik's own index.
export function geofabrikPbfUrl(geofabrik) {
  return execFileSync("node", [join(ROOT, "tools", "geofabrik-url.mjs"), geofabrik], { encoding: "utf8" }).trim();
}

// The boundary polygon (.poly) Geofabrik publishes next to each extract.
export function geofabrikPolyUrl(geofabrik) {
  return geofabrikPbfUrl(geofabrik).replace(/-latest\.osm\.pbf$/, ".poly");
}

// Name of the 1° block a point (degrees) lies in, for example lat53_lon-3 for Stockport.
export function blockName(latDeg, lonDeg) {
  return `lat${Math.floor(latDeg)}_lon${Math.floor(lonDeg)}`;
}

// Every [lat, lon] point (1e-7 degree units) of a cache record.
function recordPoints(kind, r) {
  if (kind === "warnings") return [[r.lat, r.lon]];
  if (kind === "restrictions") return [...r.from, r.via, ...r.to];
  return r.geom; // lanes and speed limits
}

// The blocks a cache record goes into: every block its points reach, widened by BLOCK_MARGIN.
export function recordBlocks(kind, r) {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const [lat, lon] of recordPoints(kind, r)) {
    minLat = Math.min(minLat, lat * 1e-7);
    maxLat = Math.max(maxLat, lat * 1e-7);
    minLon = Math.min(minLon, lon * 1e-7);
    maxLon = Math.max(maxLon, lon * 1e-7);
  }
  const out = [];
  for (let la = Math.floor(minLat - BLOCK_MARGIN); la <= Math.floor(maxLat + BLOCK_MARGIN); la++) {
    for (let lo = Math.floor(minLon - BLOCK_MARGIN); lo <= Math.floor(maxLon + BLOCK_MARGIN); lo++) out.push(`lat${la}_lon${lo}`);
  }
  return out;
}

// Splits an extract's caches (data/osm-cache/<kind>/<name>.json) into one cache per 1° block
// (data/osm-cache/<kind>/<name>@<block>.json), so a square reads the records near it instead of the whole
// extract's. The whole caches are removed afterwards. data/osm-cache/<name>.blocks.json records that the
// split is done. Kinds are split one at a time to keep memory down.
export async function splitOsmCaches(name, { log = console.log } = {}) {
  const blocks = new Set();
  for (const kind of KINDS) {
    const whole = join(CACHE, kind, `${name}.json`);
    let records;
    try {
      records = JSON.parse(await readFile(whole, "utf8"));
    } catch {
      continue; // no cache of this kind: the builder goes without it, as for any area
    }
    const byBlock = new Map();
    for (const r of records) {
      for (const b of recordBlocks(kind, r)) {
        let list = byBlock.get(b);
        if (!list) byBlock.set(b, (list = []));
        list.push(r);
      }
    }
    for (const [b, list] of byBlock) {
      await writeFile(join(CACHE, kind, `${name}@${b}.json`), JSON.stringify(list));
      blocks.add(b);
    }
    log(`${name}: ${kind} split into ${byBlock.size} block(s)`);
    await rm(whole, { force: true });
  }
  await mkdir(CACHE, { recursive: true });
  await writeFile(join(CACHE, `${name}.blocks.json`), JSON.stringify([...blocks].sort()));
}

// Makes sure an extract's split caches are there: uses them if an earlier run left them (the update workflow
// keeps data/osm-cache for a week), splits whole caches if only those are there, and otherwise downloads
// and extracts the Geofabrik file first.
export async function prepareSplitOsm({ geofabrik, name, bbox, log = console.log }) {
  const exists = (p) => stat(p).then(() => true, () => false);
  if (await exists(join(CACHE, `${name}.blocks.json`))) {
    log(`${name}: using the OSM data prepared earlier this week`);
    return;
  }
  if (!(await exists(join(CACHE, "restrictions", `${name}.json`)))) await prepareOsm({ geofabrik, name, bbox, log });
  await splitOsmCaches(name, { log });
}

// bbox is [minLon, minLat, maxLon, maxLat]. Removes the large .pbf afterwards.
export async function prepareOsm({ geofabrik, name, bbox, log = console.log }) {
  const dir = join(ROOT, "data", "osm-src");
  await mkdir(dir, { recursive: true });
  const pbf = join(dir, `${geofabrik}.osm.pbf`);
  const url = geofabrikPbfUrl(geofabrik);
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
