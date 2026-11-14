// Measures what the update workflow would cost for a region's grid squares, WITHOUT publishing anything.
// Used only by .github/workflows/measure-squares.yml. Writes small JSON and text files into measure-out/.
//
//   node tools/measure-squares.mjs --mode=whole   --name=london --bbox=-0.55,51.28,0.30,51.70 --zoom=14
//   node tools/measure-squares.mjs --mode=squares --name=london --bbox=... --zoom=14 --osm=london
//   node tools/measure-squares.mjs --mode=report
//
// whole:   builds the whole region as one map (what a region entry does) and records which restrictions matched.
// squares: builds every square with the real buildSquares() from tools/build-squares.mjs, one call per square so each
//          can be timed, then gzips it (level 9, as the workflow does), reads it back and compares its OSM data with the
//          whole-region build. The square files are deleted afterwards. Nothing is committed or uploaded.
// report:  puts the numbers together into measure-out/summary.txt.

import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTiles } from "./fetch-tiles.mjs";
import { buildArea } from "./build-area.mjs";
import { buildSquares, SQUARES_DIR } from "./build-squares.mjs";
import { squaresTouching, squareBbox, squareId, squareIndex } from "./grid.mjs";
import { readDmap } from "./dmap.mjs";
import { matchRestrictions } from "./restrictions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "measure-out");
const VIA_TOLERANCE = 300; // same as tools/restrictions.mjs

const arg = (n, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : def;
};
const mode = arg("mode", "report");
const rssMB = () => Math.round(process.resourceUsage().maxRSS / 1024);
const secs = (ms) => Math.round(ms) / 1000;
const mb = (b) => (b / 1048576).toFixed(1);

async function readJsonOr(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}
const osmFile = (kind, name) => join(ROOT, "data", "osm-cache", kind, `${name}.json`);

// matchRestrictions keeps the order of the records, so the matched list can be lined up with the records again.
// Returns, for each matched restriction, the index of the cache record it came from (-1 if not found).
function align(records, nodes, matched) {
  const out = [];
  let j = 0;
  for (const m of matched) {
    const n = nodes[m.via];
    let k = j;
    while (k < records.length) {
      const r = records[k];
      if (r.kind === m.kind && Math.abs(r.via[0] - n.lat) <= VIA_TOLERANCE && Math.abs(r.via[1] - n.lon) <= VIA_TOLERANCE) break;
      k++;
    }
    if (k >= records.length) {
      out.push(-1);
      continue;
    }
    out.push(k);
    j = k + 1;
  }
  return out;
}

function stats(values) {
  if (values.length === 0) return { n: 0, mean: 0, median: 0, p95: 0, max: 0, sum: 0 };
  const s = values.slice().sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, mean: sum / s.length, median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1], sum };
}

async function runWhole() {
  const name = arg("name", "london");
  const bbox = arg("bbox", "-0.55,51.28,0.30,51.70").split(",").map(Number);
  const zoom = Number(arg("zoom", "14"));
  const osm = arg("osm", name);
  await mkdir(OUT, { recursive: true });

  let t = Date.now();
  const fetched = await fetchTiles(bbox, zoom, { log: () => {} });
  const fetchSec = secs(Date.now() - t);
  console.log(`whole: tiles fetched in ${fetchSec}s, version ${fetched.version}`);

  t = Date.now();
  const { outFile, report } = await buildArea({ name: `measure-whole-${name}`, bbox, zoom, version: fetched.version, osmName: osm, log: () => {} });
  const buildSec = secs(Date.now() - t);

  t = Date.now();
  const map = readDmap(await readFile(outFile));
  const decodeSec = secs(Date.now() - t);
  const records = await readJsonOr(osmFile("restrictions", osm), []);
  const matchedIdx = align(records, map.nodes, map.restrictions);
  const result = {
    name,
    bbox,
    zoom,
    fetchSec,
    buildSec,
    decodeSec,
    bytes: report.bytes,
    nodes: map.nodes.length,
    edges: map.edges.length,
    restrictionsInCache: records.length,
    restrictionsMatched: map.restrictions.length,
    restrictionsUnmatched: report.restrictionsUnmatched,
    lanes: map.lanes.length,
    laneStats: report.laneStats,
    warnings: map.warnings.length,
    maxRssMB: rssMB(),
    matchedIdx: matchedIdx.filter((i) => i >= 0),
  };
  await writeFile(join(OUT, `whole-${name}.json`), JSON.stringify(result));
  await rm(outFile, { force: true });
  console.log(`whole: built in ${buildSec}s, ${mb(report.bytes)} MB, ${result.restrictionsMatched}/${records.length} restrictions, peak RSS ${result.maxRssMB} MB`);
}

// Distance in metres from a point (1e-7 degree units) to the nearest edge of a square (degrees).
function borderMetres(lat, lon, [minLat, minLon, maxLat, maxLon]) {
  const la = lat / 1e7;
  const lo = lon / 1e7;
  const dLat = Math.min(la - minLat, maxLat - la) * 111320;
  const dLon = Math.min(lo - minLon, maxLon - lo) * 111320 * Math.cos((la * Math.PI) / 180);
  return Math.max(0, Math.min(dLat, dLon));
}

async function runSquares() {
  const name = arg("name", "london");
  const bbox = arg("bbox", "-0.55,51.28,0.30,51.70").split(",").map(Number);
  const zoom = Number(arg("zoom", "14"));
  const osm = arg("osm", "none") === "none" ? undefined : arg("osm");
  const budgetMin = Number(arg("budget-min", "100"));
  const [minLon, minLat, maxLon, maxLat] = bbox;
  await mkdir(OUT, { recursive: true });

  const whole = await readJsonOr(join(OUT, `whole-${name}.json`), null);
  const wholeSet = new Set(whole ? whole.matchedIdx : []);
  const records = osm ? await readJsonOr(osmFile("restrictions", osm), []) : [];
  const lanesCache = osm ? await readJsonOr(osmFile("lanes", osm), []) : [];
  const warningsCache = osm ? await readJsonOr(osmFile("warnings", osm), []) : [];

  // Which square owns each restriction record: the square its via node is in.
  const owned = new Map();
  records.forEach((r, i) => {
    const id = squareId(squareIndex(r.via[0] / 1e7, r.via[1] / 1e7));
    if (!owned.has(id)) owned.set(id, []);
    owned.get(id).push(i);
  });

  const squares = squaresTouching([minLat, minLon, maxLat, maxLon]);
  const started = Date.now();
  const rows = [];
  const errors = [];
  const matchCount = new Int16Array(records.length); // in how many squares each record matched
  const tally = { inside: { both: 0, wholeOnly: 0, squareOnly: 0, neither: 0 }, straddle: { both: 0, wholeOnly: 0, squareOnly: 0, neither: 0 } };
  const lostReasons = { noVia: 0, noFrom: 0, noTo: 0, matchesWhenAlone: 0, uTurn: 0 };
  const lostBorder = { "<50m": 0, "50-200m": 0, "200-500m": 0, ">=500m": 0 };
  const lostExamples = [];
  let skipped = 0;

  for (const sq of squares) {
    if ((Date.now() - started) / 60000 > budgetMin) break;
    const id = squareId(sq);
    const bb = squareBbox(sq); // [minLat, minLon, maxLat, maxLon]
    const e = 1e-6;
    const t0 = Date.now();
    let res;
    try {
      // A bbox just inside the square makes buildSquares() build exactly this one square, with its own code path.
      res = await buildSquares({ bbox: [bb[1] + e, bb[0] + e, bb[3] - e, bb[2] - e], zoom, osm, log: () => {} });
    } catch (err) {
      errors.push(`${id}: ${err.message}`);
      continue;
    }
    const buildSec = secs(Date.now() - t0);
    if (res.built !== 1) {
      skipped++;
      continue;
    }
    const file = join(SQUARES_DIR, `${id}.dmap`);
    const raw = await readFile(file);
    const tz = Date.now();
    const gz = gzipSync(raw, { level: 9 });
    const gzipSec = secs(Date.now() - tz);
    const map = readDmap(raw);
    const row = {
      id,
      buildSec,
      gzipSec,
      rawBytes: raw.length,
      gzBytes: gz.length,
      nodes: map.nodes.length,
      edges: map.edges.length,
      polygons: map.polygons.length,
      labels: map.labels.length,
      restrictions: map.restrictions.length,
      lanes: map.lanes.length,
      warnings: map.warnings.length,
      rssMB: rssMB(),
    };

    if (records.length > 0) {
      const idx = align(records, map.nodes, map.restrictions);
      const here = new Set(idx.filter((i) => i >= 0));
      for (const i of here) matchCount[i]++;
      const [bMinLat, bMinLon, bMaxLat, bMaxLon] = bb.map((d) => Math.round(d * 1e7));
      const insideSq = (p) => p[0] >= bMinLat && p[0] <= bMaxLat && p[1] >= bMinLon && p[1] <= bMaxLon;
      for (const i of owned.get(id) || []) {
        const r = records[i];
        const straddles = !(r.from.every(insideSq) && r.to.every(insideSq));
        const w = wholeSet.has(i);
        const o = here.has(i);
        const cell = tally[straddles ? "straddle" : "inside"];
        if (w && o) cell.both++;
        else if (w) cell.wholeOnly++;
        else if (o) cell.squareOnly++;
        else cell.neither++;
        if (w && !o) {
          const why = matchRestrictions(map.nodes, map.edges, [r]);
          const reason = why.uTurns ? "uTurn" : why.unmatched.noVia ? "noVia" : why.unmatched.noFrom ? "noFrom" : why.unmatched.noTo ? "noTo" : "matchesWhenAlone";
          lostReasons[reason]++;
          const d = borderMetres(r.via[0], r.via[1], bb);
          lostBorder[d < 50 ? "<50m" : d < 200 ? "50-200m" : d < 500 ? "200-500m" : ">=500m"]++;
          if (lostExamples.length < 12) lostExamples.push({ square: id, via: r.via, reason, borderM: Math.round(d), straddles });
        }
      }
    }
    rows.push(row);
    await rm(file, { force: true });
    if (rows.length % 10 === 0) console.log(`squares ${name}: ${rows.length}/${squares.length}, last ${buildSec}s, elapsed ${secs(Date.now() - started)}s, RSS ${rssMB()} MB`);
  }

  // Records matched by the whole build, by some square, by the square that owns them, and by several squares.
  let lostEverywhere = 0;
  let gainedSomewhere = 0;
  let matchedInSeveral = 0;
  let squareMatches = 0;
  for (let i = 0; i < records.length; i++) {
    squareMatches += matchCount[i];
    if (matchCount[i] > 1) matchedInSeveral++;
    if (wholeSet.has(i) && matchCount[i] === 0) lostEverywhere++;
    if (!wholeSet.has(i) && matchCount[i] > 0) gainedSomewhere++;
  }

  const result = {
    name,
    osm: osm ?? null,
    squaresInArea: squares.length,
    squaresBuilt: rows.length,
    squaresSkippedUpToDate: skipped,
    incomplete: rows.length + skipped < squares.length,
    errors,
    elapsedSec: secs(Date.now() - started),
    maxRssMB: rssMB(),
    rows,
    osmCache: { restrictions: records.length, lanes: lanesCache.length, warnings: warningsCache.length },
    restrictions: {
      tally,
      lostReasons,
      lostBorder,
      lostExamples,
      lostEverywhere,
      gainedSomewhere,
      matchedInSeveral,
      sumOfSquareMatches: squareMatches,
      hadWholeBuild: Boolean(whole),
    },
  };
  await writeFile(join(OUT, `squares-${name}.json`), JSON.stringify(result));
  console.log(`squares ${name}: ${rows.length} built, ${errors.length} errors, ${result.elapsedSec}s, peak RSS ${result.maxRssMB} MB`);
}

async function parseTime(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  const rss = /Maximum resident set size \(kbytes\): (\d+)/.exec(text);
  const wall = /Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): ([\d:.]+)/.exec(text);
  let sec = null;
  if (wall) sec = wall[1].split(":").reduce((a, p) => a * 60 + Number(p), 0);
  return { rssMB: rss ? Math.round(Number(rss[1]) / 1024) : null, wallSec: sec };
}

async function runReport() {
  const whole = await readJsonOr(join(OUT, `whole-${arg("name", "london")}.json`), null);
  const ldn = await readJsonOr(join(OUT, `squares-${arg("name", "london")}.json`), null);
  const stk = await readJsonOr(join(OUT, "squares-stockport.json"), null);
  const prep = await parseTime(join(OUT, "prepare.time"));
  const L = [];
  const p = (s = "") => L.push(s);
  const min = (s) => (s / 60).toFixed(1);

  p("MEASURE SQUARES: London (nothing published, committed or released)");
  p("=".repeat(64));
  p(`OSM prepare (download greater-london + extract): ${prep.wallSec ?? "?"} s, peak RSS ${prep.rssMB ?? "?"} MB`);
  if (whole) {
    p(`Whole London map: tiles ${whole.fetchSec}s (cold), build ${whole.buildSec}s, decode ${whole.decodeSec}s, ${mb(whole.bytes)} MB, peak RSS ${whole.maxRssMB} MB`);
    p(`  nodes ${whole.nodes}, edges ${whole.edges}, restrictions ${whole.restrictionsMatched}/${whole.restrictionsInCache} matched, unmatched ${JSON.stringify(whole.restrictionsUnmatched)}, lanes ${whole.lanes}, warnings ${whole.warnings}`);
  }
  let sqBuild = 0;
  let sqGzip = 0;
  if (ldn) {
    const rows = ldn.rows;
    const bt = stats(rows.map((r) => r.buildSec));
    const gt = stats(rows.map((r) => r.gzipSec));
    const raw = stats(rows.map((r) => r.rawBytes));
    const gz = stats(rows.map((r) => r.gzBytes));
    sqBuild = bt.sum;
    sqGzip = gt.sum;
    p();
    p(`SQUARES (London, zoom ${14}): ${ldn.squaresBuilt} built of ${ldn.squaresInArea} in area${ldn.incomplete ? "  ** INCOMPLETE (time budget or errors) **" : ""}, ${ldn.squaresSkippedUpToDate} skipped, ${ldn.errors.length} errors`);
    for (const e of ldn.errors.slice(0, 10)) p(`  error: ${e}`);
    p(`  build time: total ${bt.sum.toFixed(0)} s (${min(bt.sum)} min), mean ${bt.mean.toFixed(1)} s, median ${bt.median.toFixed(1)} s, p95 ${bt.p95.toFixed(1)} s, max ${bt.max.toFixed(1)} s`);
    p(`  gzip -9 time: total ${gt.sum.toFixed(0)} s, max ${gt.max.toFixed(1)} s`);
    p(`  raw bytes: total ${mb(raw.sum)} MB, mean ${mb(raw.mean)} MB, max ${mb(raw.max)} MB`);
    p(`  gzipped bytes: total ${mb(gz.sum)} MB (${((100 * gz.sum) / (raw.sum || 1)).toFixed(0)}% of raw), mean ${mb(gz.mean)} MB, max ${mb(gz.max)} MB`);
    p(`  peak memory of the squares loop: ${ldn.maxRssMB} MB`);
    p("  biggest squares (raw MB / gz MB / build s / edges / restrictions / warnings):");
    for (const r of rows.slice().sort((a, b) => b.rawBytes - a.rawBytes).slice(0, 10)) {
      p(`    ${r.id}: ${mb(r.rawBytes)} / ${mb(r.gzBytes)} / ${r.buildSec} / ${r.edges} / ${r.restrictions} / ${r.warnings}`);
    }
    p("  slowest squares:");
    for (const r of rows.slice().sort((a, b) => b.buildSec - a.buildSec).slice(0, 5)) p(`    ${r.id}: ${r.buildSec} s, ${mb(r.rawBytes)} MB`);

    // OSM data per square versus the whole build.
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    p();
    p("OSM DATA IN SQUARES vs WHOLE LONDON BUILD");
    if (whole) {
      p(`  nodes:        squares sum ${sum("nodes")} vs whole ${whole.nodes}  (x${(sum("nodes") / whole.nodes).toFixed(2)})`);
      p(`  edges:        squares sum ${sum("edges")} vs whole ${whole.edges}  (x${(sum("edges") / whole.edges).toFixed(2)})`);
      p(`  restrictions: squares sum ${sum("restrictions")} vs whole ${whole.restrictionsMatched}  (x${(sum("restrictions") / (whole.restrictionsMatched || 1)).toFixed(2)})`);
      p(`  lanes:        squares sum ${sum("lanes")} vs whole ${whole.lanes}  (x${(sum("lanes") / (whole.lanes || 1)).toFixed(2)})`);
      p(`  warnings:     squares sum ${sum("warnings")} vs whole ${whole.warnings}  (x${(sum("warnings") / (whole.warnings || 1)).toFixed(2)})`);
    }
    p(`  warnings per square: min ${Math.min(...rows.map((r) => r.warnings))}, max ${Math.max(...rows.map((r) => r.warnings))}, in the London cache ${ldn.osmCache.warnings}`);
    p(`  squares with no restriction: ${rows.filter((r) => r.restrictions === 0).length}, with no lanes: ${rows.filter((r) => r.lanes === 0).length}`);
    const R = ldn.restrictions;
    p();
    p(`RESTRICTIONS: each cache record is checked in the square that owns its via node (${ldn.osmCache.restrictions} records in the cache)`);
    for (const k of ["inside", "straddle"]) {
      const c = R.tally[k];
      p(`  ${k === "inside" ? "from/to nodes inside the square" : "from or to node outside the square (straddles the border)"}: matched in both ${c.both}, LOST by square ${c.wholeOnly}, only square ${c.squareOnly}, neither ${c.neither}`);
    }
    p(`  lost in the owner square: reasons ${JSON.stringify(R.lostReasons)}; via node distance to the border ${JSON.stringify(R.lostBorder)}`);
    p(`  lost in EVERY square (matched by the whole build, by none of the squares): ${R.lostEverywhere}`);
    p(`  matched by squares but not whole build: ${R.gainedSomewhere}; matched in more than one square (duplicates): ${R.matchedInSeveral}; sum of matches over squares ${R.sumOfSquareMatches}`);
    for (const x of R.lostExamples) p(`    example: ${x.square} via ${x.via} ${x.reason}, ${x.borderM} m from border${x.straddles ? ", straddles" : ""}`);
    if (!R.hadWholeBuild) p("  (no whole-London build was available, so loss figures are not valid)");
  } else {
    p("No London squares result.");
  }

  if (stk) {
    const bt = stats(stk.rows.map((r) => r.buildSec));
    p();
    p(`STOCKPORT SQUARES (old builder graph-repair-1 in the index): ${stk.squaresBuilt} rebuilt, ${stk.squaresSkippedUpToDate} skipped as up to date, of ${stk.squaresInArea} in area; ${stk.errors.length} errors`);
    p(`  build total ${bt.sum.toFixed(0)} s, mean ${bt.mean.toFixed(1)} s, max ${bt.max.toFixed(1)} s, raw ${mb(stats(stk.rows.map((r) => r.rawBytes)).sum)} MB`);
  }

  // Would the update job fit 120 minutes? Region entry and squares entry both prepare OSM, so the download runs twice.
  p();
  p("JOB ESTIMATE FOR ONE UPDATE RUN (london switched on; runner = ubuntu-latest, same as this job)");
  const stkBuild = stk ? stats(stk.rows.map((r) => r.buildSec)).sum : 0;
  if (whole && ldn && prep.wallSec != null) {
    const parts = [
      ["OSM prepare x2 (region + squares each download and extract)", 2 * prep.wallSec],
      ["tile download (cold)", whole.fetchSec],
      ["whole London build", whole.buildSec],
      ["test-map decode of whole London file", whole.decodeSec],
      ["London squares build", sqBuild],
      ["gzip of London squares", sqGzip],
      ["Stockport squares rebuild (builder changed)", stkBuild],
      ["Stockport region rebuild (estimated as equal to its squares)", stkBuild],
    ];
    let total = 0;
    for (const [label, s] of parts) {
      total += s;
      p(`  ${label}: ${min(s)} min`);
    }
    p(`  TOTAL about ${min(total)} min of 120 (not measured: release upload, git, checkout, test-map of squares)`);
    p(`  verdict: ${total <= 96 * 60 ? "FITS with margin (under 80% of the limit)" : total <= 120 * 60 ? "FITS ONLY WITHOUT MARGIN" : "DOES NOT FIT"}${ldn.incomplete ? " (squares run incomplete, so the real total is higher)" : ""}`);
    const perSq = sqBuild / Math.max(1, ldn.squaresBuilt) + sqGzip / Math.max(1, ldn.squaresBuilt);
    const fixed = 2 * prep.wallSec + whole.fetchSec + whole.buildSec + whole.decodeSec + 2 * stkBuild;
    const budget = 90 * 60; // leave 30 minutes of margin
    const cap = Math.max(0, Math.floor((budget - fixed) / perSq));
    const capSquaresOnly = Math.floor((budget - prep.wallSec) / perSq);
    p(`  squares per run that keep a 90 minute budget: ${cap} (with the region build in the same run), ${capSquaresOnly} (squares only, one OSM prepare)`);
    p(`  runs needed for the ${ldn.squaresInArea} London squares at that cap: ${capSquaresOnly > 0 ? Math.ceil(ldn.squaresInArea / capSquaresOnly) : "?"}`);
  } else {
    p("  not enough measurements for an estimate");
  }
  p();
  p(`Release upload size per run if all London squares are uploaded: raw+gz ${ldn ? mb(stats(ldn.rows.map((r) => r.rawBytes)).sum + stats(ldn.rows.map((r) => r.gzBytes)).sum) : "?"} MB, ${ldn ? ldn.rows.length * 2 : "?"} files (gh release upload --clobber re-uploads every file every run)`);
  const text = L.join("\n") + "\n";
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "summary.txt"), text);
  console.log(text);
}

if (mode === "whole") await runWhole();
else if (mode === "squares") await runSquares();
else await runReport();
