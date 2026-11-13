// Scale measurement helpers for the map pipeline. Build-time only, our own code.
// Does not change any other tool: it only spawns them and watches the process from /proc.
//
// Modes:
//   node tools/scale-report.mjs run --label=NAME --out=FILE.json [--pbf=FILE] -- <command> [args...]
//       Runs the command, samples its resident memory (RSS) from /proc every 250 ms, and writes
//       wall time, peak RSS and (with --pbf) the time of each extractor pass. The extractor reads
//       the whole .osm.pbf once per pass, so a pass ends when the bytes read (/proc/<pid>/io rchar)
//       pass 1x, 2x and 3x the file size. Pass times are therefore approximate (about 0.25 s).
//   node tools/scale-report.mjs grid --bbox=minLon,minLat,maxLon,maxLat --out=FILE.json
//       Counts the grid squares (tools/grid.mjs) the bbox touches.
//   node tools/scale-report.mjs sizes --file=X.dmap --out=FILE.json
//       Raw, gzip -9 and gzip -6 sizes of a map file (uses the gzip command; nothing is kept).
//   node tools/scale-report.mjs estimate --mid=SIZES.json --km2-mid=N --km2-country=N --grid=GRID.json --out=FILE.json
//       Extrapolates a country map's gzipped size and prints a summary (see the method in the output).

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { squaresTouching } from "./grid.mjs";

const args = process.argv.slice(2);
const mode = args[0];
const sep = args.indexOf("--");
const flags = args.slice(1, sep < 0 ? undefined : sep);
const arg = (n, def) => {
  const hit = flags.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : def;
};
const mb = (b) => (b / 1048576).toFixed(1);
const save = (obj) => {
  const out = arg("out");
  if (out) writeFileSync(out, JSON.stringify(obj, null, 2) + "\n");
};

function procRss(pid) {
  // Total RSS of the process and its children (the wrapped command may be a shell or node).
  let total = 0;
  try {
    const kids = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    for (const k of kids) total += procRss(k);
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (m) total += Number(m[1]) * 1024;
  } catch {}
  return total;
}
function procRchar(pid) {
  try {
    return Number(/rchar: (\d+)/.exec(readFileSync(`/proc/${pid}/io`, "utf8"))[1]);
  } catch {
    return 0;
  }
}

async function run() {
  if (sep < 0 || !args[sep + 1]) throw new Error("usage: scale-report.mjs run --label=X --out=F -- command args");
  const label = arg("label", "run");
  const pbf = arg("pbf");
  const pbfSize = pbf ? statSync(pbf).size : 0;
  const started = Date.now();
  const child = spawn(args[sep + 1], args.slice(sep + 2), { stdio: ["ignore", "inherit", "inherit"] });
  let peakRss = 0;
  const rssSeries = []; // [seconds, MB], one point every 5 s
  const passEnds = [];
  let lastPoint = -5;
  const timer = setInterval(() => {
    const t = (Date.now() - started) / 1000;
    const rss = procRss(child.pid);
    if (rss > peakRss) peakRss = rss;
    if (t - lastPoint >= 5) {
      rssSeries.push([Math.round(t), Math.round(rss / 1048576)]);
      lastPoint = t;
    }
    if (pbfSize) {
      const read = procRchar(child.pid);
      while (passEnds.length < 3 && read >= pbfSize * (passEnds.length + 1)) passEnds.push(t);
    }
  }, 250);
  const code = await new Promise((r) => child.on("close", (c, s) => r(c === null ? 128 : c)));
  clearInterval(timer);
  const wall = (Date.now() - started) / 1000;
  const passSeconds = passEnds.map((t, i) => +(t - (i ? passEnds[i - 1] : 0)).toFixed(1));
  const result = {
    label,
    exitCode: code,
    wallSeconds: +wall.toFixed(1),
    peakRssMB: +mb(peakRss),
    ...(pbfSize ? { pbfMB: +mb(pbfSize), passSecondsApprox: passSeconds } : {}),
    rssSeries,
  };
  console.log(`\n=== scale-report ${label}: exit ${code}, wall ${result.wallSeconds}s, peak RSS ${result.peakRssMB} MB` +
    (passSeconds.length ? `, pass seconds (relations, ways, nodes) ~ ${passSeconds.join(" / ")}` : "") + " ===");
  save(result);
  process.exit(code);
}

function gz(file, level) {
  // Size of the gzip output, streamed so nothing is written to disk.
  const out = execFileSync("sh", ["-c", `gzip -${level} -c "$1" | wc -c`, "sh", file], { encoding: "utf8" });
  return Number(out.trim());
}

function grid() {
  const bbox = arg("bbox").split(",").map(Number); // minLon,minLat,maxLon,maxLat
  const sq = squaresTouching([bbox[1], bbox[0], bbox[3], bbox[2]]);
  const r = { bbox, squaresTouchingBbox: sq.length };
  console.log(`grid: bbox ${bbox.join(",")} touches ${sq.length} squares (0.05 degree)`);
  save(r);
}

function sizes() {
  const file = arg("file");
  const raw = statSync(file).size;
  const t0 = Date.now();
  const g9 = gz(file, 9);
  const t9 = (Date.now() - t0) / 1000;
  const t1 = Date.now();
  const g6 = gz(file, 6);
  const t6 = (Date.now() - t1) / 1000;
  const r = { file, rawBytes: raw, gzip9Bytes: g9, gzip6Bytes: g6, ratio9: +(raw / g9).toFixed(2), ratio6: +(raw / g6).toFixed(2), gzip9Seconds: +t9.toFixed(1), gzip6Seconds: +t6.toFixed(1) };
  console.log(`sizes: raw ${mb(raw)} MB, gzip -9 ${mb(g9)} MB (x${r.ratio9}, ${r.gzip9Seconds}s), gzip -6 ${mb(g6)} MB (x${r.ratio6}, ${r.gzip6Seconds}s)`);
  save(r);
}

function estimate() {
  const s = JSON.parse(readFileSync(arg("mid"), "utf8"));
  const g = JSON.parse(readFileSync(arg("grid"), "utf8"));
  const kmMid = Number(arg("km2-mid"));
  const kmCountry = Number(arg("km2-country"));
  const perKm2 = s.gzip9Bytes / kmMid;
  const upper = perKm2 * kmCountry; // whole country as dense as the mid-size region
  const factors = [0.25, 0.5, 1];
  const lines = [];
  lines.push(`Method: gzip -9 bytes per km2 of the mid-size region (${mb(s.gzip9Bytes)} MB over ${kmMid} km2 = ${(perKm2 / 1024).toFixed(1)} KB/km2),`);
  lines.push(`times the country area (${kmCountry} km2). The mid-size region is dense and urban, so this is an upper bound; a country is`);
  lines.push(`mostly rural and its density is probably 25-60% of it (assumed, not measured). Uncertainty: about a factor of 3 either way.`);
  const rows = factors.map((f) => ({ densityFactor: f, countryGzipMB: +mb(upper * f), phoneDownloadMBAt20Mbps_seconds: +((upper * f * 8) / 20e6).toFixed(0), under2GiBReleaseLimit: upper * f < 2 * 1024 ** 3 }));
  for (const r of rows) lines.push(`  density x${r.densityFactor}: ~${r.countryGzipMB} MB gzipped, ${r.under2GiBReleaseLimit ? "under" : "OVER"} the 2 GiB release asset limit, ~${r.phoneDownloadMBAt20Mbps_seconds} s at 20 Mbit/s`);
  const area = 0.05 * 111.2 * 0.05 * 111.2 * Math.cos((52.5 * Math.PI) / 180); // km2 of one square at lat 52.5
  const landSquares = Math.round(kmCountry / area);
  lines.push(`Squares: ${g.squaresTouchingBbox} touch the England bounding box (mostly sea/Wales/Scotland, so a large over-count);`);
  lines.push(`by area, England needs about ${landSquares} squares of ${area.toFixed(1)} km2 (plus edge squares, so roughly +10-15%).`);
  lines.push(`Squares total, same bytes/km2 (square files repeat roads that cross borders and have fixed headers): about the same ${mb(upper * 0.5)} MB at x0.5 plus 5-15% overlap.`);
  const text = lines.join("\n");
  console.log(text);
  save({ perKm2Bytes: perKm2, rows, landSquaresByArea: landSquares, squaresTouchingBbox: g.squaresTouchingBbox, text });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const modes = { run, grid, sizes, estimate };
  if (!modes[mode]) {
    console.error("modes: run | grid | sizes | estimate (see the top of this file)");
    process.exit(1);
  }
  await modes[mode]();
}
