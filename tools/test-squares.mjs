// Tests every grid square file: decodes, lies inside its own square, has roads, and is small enough.
// Also tests growing outwards (regions.json "grow"): the boundary, the order, resuming, releases and the
// 1 degree split of the OSM data. Those checks need no network and no map files.
// Usage: node tools/test-squares.mjs

import { readFile, readdir, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDmap, fromFixed7 } from "./dmap.mjs";
import { squareBbox, squareIndex, squareId } from "./grid.mjs";
import { indexEntry, parsePoly, insidePoly, growthOrder, resumeAt, squareRelease } from "./build-squares.mjs";
import { recordBlocks } from "./osm-prepare.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "published", "squares");
const MAX_BYTES = 100 * 1024 * 1024;
const failures = [];
const index = JSON.parse(await readFile(join(DIR, "index.json"), "utf8"));
const files = (await readdir(DIR)).filter((f) => f.endsWith(".dmap"));

for (const file of files) {
  const id = file.replace(/\.dmap$/, "");
  const size = (await stat(join(DIR, file))).size;
  if (size > MAX_BYTES) failures.push(`${id}: over 100 MB`);
  if (!index[id]) failures.push(`${id}: no index entry`);
  let map;
  try {
    map = readDmap(await readFile(join(DIR, file)));
  } catch (err) {
    failures.push(`${id}: does not decode: ${err.message}`);
    continue;
  }
  // The file name must match the square its bounding box belongs to.
  const [minLat, minLon, maxLat, maxLon] = map.bbox.map(fromFixed7);
  const named = squareIndex(minLat + 1e-9, minLon + 1e-9);
  if (squareId(named) !== id) failures.push(`${id}: bounding box belongs to ${squareId(named)}`);
  const [sMinLat, , sMaxLat] = squareBbox(named);
  if (Math.abs(sMinLat - minLat) > 1e-6 || Math.abs(sMaxLat - maxLat) > 1e-6) failures.push(`${id}: bounding box is not a grid square`);
  if (map.edges.length === 0) failures.push(`${id}: no roads`);
  console.log(`${id}: ok (${size} bytes, ${map.edges.length} roads)`);
}
// Recorded compressed size: the index entry's gzBytes must equal the size of the .dmap.gz that
// "gzip -9 -c <file> > <file>.gz" writes (the release's step). Uses a temporary folder, removed after.
{
  const tmp = await mkdtemp(join(tmpdir(), "squares-gz-"));
  const dmap = join(tmp, "lat0_lon0.dmap");
  // Deterministic, moderately compressible content of about 300 KB.
  const data = Buffer.alloc(300 * 1024);
  let seed = 7;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 16807) % 2147483647;
    data[i] = i % 4096 < 2048 ? seed & 0x0f : seed & 0xff;
  }
  await writeFile(dmap, data);
  const made = spawnSync("sh", ["-c", `gzip -9 -c "${dmap}" > "${dmap}.gz"`]);
  const gzSize = (await stat(dmap + ".gz")).size;
  const entry = indexEntry({ version: "test", builder: "test", zoom: 14, bbox: [0, 0, 1, 1], file: dmap });
  const back = spawnSync("gzip", ["-d", "-c", dmap + ".gz"], { maxBuffer: 64 * 1024 * 1024 });
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else { failures.push(name); console.log(`FAIL ${name} ${detail}`); }
  };
  check("gzip step for the test file ran", made.status === 0, `status=${made.status}`);
  check("recorded gzBytes equals the size of the .dmap.gz file", entry.gzBytes === gzSize, `gzBytes=${entry.gzBytes} file=${gzSize}`);
  check("recorded bytes equals the size of the .dmap file", entry.bytes === data.length, `bytes=${entry.bytes} file=${data.length}`);
  check("the recorded compressed size is smaller than the raw size", entry.gzBytes < entry.bytes, `gz=${entry.gzBytes} raw=${entry.bytes}`);
  check("the .dmap.gz decompresses to the original file", back.status === 0 && Buffer.compare(back.stdout, data) === 0);
  await rm(tmp, { recursive: true, force: true });
}

// Growing outwards. A boundary 0.2 degrees square around (53.40, -2.20), in Osmosis .poly form ("lon lat" lines),
// with a hole over the south-west square.
{
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else { failures.push(name); console.log(`FAIL ${name} ${detail}`); }
  };
  const outer = ["1", "  -2.30E+00  5.330E+01", "  -2.10E+00  5.330E+01", "  -2.10E+00  5.350E+01", "  -2.30E+00  5.350E+01", "END"];
  const hole = ["!2", "  -2.30 53.30", "  -2.25 53.30", "  -2.25 53.35", "  -2.30 53.35", "END"];
  const poly = parsePoly(["test", ...outer, ...hole, "END", ""].join("\n"));
  check("boundary: one ring and one hole are read", poly.rings.length === 2 && !poly.rings[0].hole && poly.rings[1].hole);
  check("boundary: its box comes from the outer ring", JSON.stringify(poly.bbox) === JSON.stringify([-2.3, 53.3, -2.1, 53.5]), JSON.stringify(poly.bbox));
  check("boundary: a point inside is inside", insidePoly(poly, 53.4, -2.2));
  check("boundary: a point in the hole is outside", !insidePoly(poly, 53.32, -2.28));
  check("boundary: a point beyond it is outside", !insidePoly(poly, 53.6, -2.2));

  // The boundary covers squares lat1066..1069 and lon-46..-43: 16 squares, less the one in the hole.
  const from = [53.4, -2.2];
  const order = growthOrder(poly, from);
  const ids = order.map((o) => o.id);
  check("order: every square whose centre is inside, none in the hole", order.length === 15 && !ids.includes("lat1066_lon-46"), ids.join(","));
  check("order: nearest first", order.every((o, i) => i === 0 || order[i - 1].km <= o.km));
  check("order: the four squares around the start come first", ["lat1067_lon-45", "lat1067_lon-44", "lat1068_lon-45", "lat1068_lon-44"].every((id) => ids.slice(0, 4).includes(id)), ids.slice(0, 4).join(","));
  // The start is on a grid corner, so the two squares north of it, east and west, are at exactly the same distance.
  check("order: squares at the same distance are ordered by id", order[0].km === order[1].km && order[0].id === "lat1068_lon-44" && order[1].id === "lat1068_lon-45", `${ids[0]} ${order[0].km} ${ids[1]} ${order[1].km}`);

  check("resume: with no square reached yet, start at the beginning", resumeAt(order, null, from) === 0);
  check("resume: carry on just after the last square reached", resumeAt(order, order[5].id, from) === 6);
  check("resume: after the last square, nothing is left", resumeAt(order, order[order.length - 1].id, from) === order.length);
  // A square no longer in the order (the boundary changed): carry on from its distance.
  const full = growthOrder(parsePoly(["test", ...outer, "END", ""].join("\n")), from);
  const gone = full.find((o) => o.id === "lat1066_lon-46");
  const k = resumeAt(order, gone.id, from);
  check("resume: a square that has left the boundary still gives the right place", order.slice(0, k).every((o) => o.km <= gone.km) && order.slice(k).every((o) => o.km >= gone.km), `k=${k}`);

  check("release: Stockport's squares go to squares-lat53_lon-3", squareRelease({ latIdx: 1067, lonIdx: -45 }) === "squares-lat53_lon-3");
  check("release: just west of Greenwich is block lon-1, just east is block lon0", squareRelease({ latIdx: 1030, lonIdx: -1 }) === "squares-lat51_lon-1" && squareRelease({ latIdx: 1030, lonIdx: 0 }) === "squares-lat51_lon0");
  const tags = new Set();
  let inStockportBlock = 0;
  for (let la = 1050; la < 1090; la++) {
    for (let lo = -70; lo < -30; lo++) {
      const t = squareRelease({ latIdx: la, lonIdx: lo });
      tags.add(t);
      if (t === "squares-lat53_lon-3") inStockportBlock++;
    }
  }
  // lat 1050..1089 and lon -70..-31 span 3 by 3 one-degree blocks.
  check("release: each 1 degree block has its own release, of at most 400 squares", inStockportBlock === 400 && tags.size === 9, `${inStockportBlock} squares, ${tags.size} releases`);

  const way = { geom: [[539950000, -21000000], [540050000, -21000000]] }; // 53.995 to 54.005 north: crosses 54
  check("OSM split: a road that crosses a block edge goes into both blocks", JSON.stringify(recordBlocks("speed", way).sort()) === JSON.stringify(["lat53_lon-3", "lat54_lon-3"]), JSON.stringify(recordBlocks("speed", way)));
  check("OSM split: a record within 0.01 degrees of a block edge also goes into the next block", recordBlocks("warnings", { kind: 1, lat: 539950000, lon: -25000000 }).length === 2);
  check("OSM split: a record in the middle of a block goes into that block only", JSON.stringify(recordBlocks("warnings", { kind: 1, lat: 535000000, lon: -25000000 })) === JSON.stringify(["lat53_lon-3"]));
  const ban = { kind: 1, from: [[535000000, -25000000], [535010000, -25000000]], via: [535000000, -25000000], to: [[535000000, -25000000], [535000000, -25010000]] };
  check("OSM split: a turn restriction goes into the block of its roads", JSON.stringify(recordBlocks("restrictions", ban)) === JSON.stringify(["lat53_lon-3"]));
}

if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log(`all ${files.length} square file(s) passed`);
