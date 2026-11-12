// Adds new map regions and rebuilds regions whose source has changed.
// Each run builds at most MAX_REGIONS_PER_RUN regions, so runs stay short.
// A region is skipped when its index entry already matches the current source version.
// Usage: node tools/update-regions.mjs

import { readFile, writeFile, copyFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceVersion, fetchTiles } from "./fetch-tiles.mjs";
import { buildArea } from "./build-area.mjs";
import { buildSquares } from "./build-squares.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED = join(ROOT, "data", "published");
const MAX_REGIONS_PER_RUN = Number(process.env.MAX_REGIONS_PER_RUN ?? 2);
// Change this when the builder changes output, so existing regions are rebuilt.
const BUILDER_VERSION = "graph-repair-1";

const config = JSON.parse(await readFile(join(ROOT, "regions.json"), "utf8"));
const regions = Array.isArray(config) ? config : config.regions;
const squareAreas = Array.isArray(config) ? [] : config.squareAreas ?? [];
const indexFile = join(PUBLISHED, "index.json");
let index = {};
try {
  index = JSON.parse(await readFile(indexFile, "utf8"));
} catch {
  index = {};
}

await mkdir(PUBLISHED, { recursive: true });
const { version } = await sourceVersion();
console.log(`source version ${version}`);

let built = 0;
for (const region of regions) {
  const out = join(PUBLISHED, `${region.id}.dmap`);
  const exists = await stat(out).then(() => true, () => false);
  const previous = index[region.id];

  if (previous && previous.version === version && previous.builder === BUILDER_VERSION && exists) {
    index[region.id].url = `https://github.com/${process.env.GITHUB_REPOSITORY ?? "phuk-prog/Drivemate-map"}/releases/download/maps-latest/${region.id}.dmap`;
    console.log(`${region.id}: up to date`);
    continue;
  }
  if (built >= MAX_REGIONS_PER_RUN) {
    console.log(`${region.id}: waiting for a later run`);
    continue;
  }

  console.log(`${region.id}: ${previous ? "source changed, rebuilding" : "new region, building"}`);
  await fetchTiles(region.bbox, region.zoom, { log: () => {} });
  await buildArea({ name: region.id, bbox: region.bbox, zoom: region.zoom, version, log: () => {} });
  await copyFile(join(ROOT, "data", "out", `${region.id}.dmap`), out);
  index[region.id] = {
    version,
    builder: BUILDER_VERSION,
    zoom: region.zoom,
    bbox: region.bbox,
    url: `https://github.com/${process.env.GITHUB_REPOSITORY ?? "phuk-prog/Drivemate-map"}/releases/download/maps-latest/${region.id}.dmap`,
    bytes: (await stat(out)).size,
    builtAt: new Date().toISOString(),
  };
  built++;
}

await writeFile(indexFile, JSON.stringify(index, null, 2) + "\n");
console.log(`built ${built} region(s)`);

// Grid squares for drawn-area downloads. Each square is rebuilt only when the source or builder changes.
for (const area of squareAreas) {
  const bbox = [area.bbox[0], area.bbox[1], area.bbox[2], area.bbox[3]];
  await buildSquares({ bbox, zoom: area.zoom, log: console.log });
}
