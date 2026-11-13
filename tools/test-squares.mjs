// Tests every grid square file: decodes, lies inside its own square, has roads, and is small enough.
// Usage: node tools/test-squares.mjs

import { readFile, readdir, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDmap, fromFixed7 } from "./dmap.mjs";
import { squareBbox, squareIndex, squareId } from "./grid.mjs";
import { indexEntry } from "./build-squares.mjs";

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

if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log(`all ${files.length} square file(s) passed`);
