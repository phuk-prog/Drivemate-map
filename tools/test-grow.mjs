// Tests county-by-county growth with a small hand-made Geofabrik index in the real format
// (tools/fixtures/geofabrik-index-sample.json): order by distance, choice of extracts, growth
// state, row releases and their URLs, extract re-download rules, and the --dry-run output.
// Needs no network. Usage: node tools/test-grow.mjs

import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_STATE, candidateAreas, orderAreas, planGrowth, extractsFor, squaresInGeometry, squaresForArea,
  recordFinished, readGrowth, writeGrowth, distanceKm, squaresBbox,
} from "./grow.mjs";
import { squareRelease, squareUrl, squareId, parseSquareId, squareBbox, SQUARES_PER_DEGREE } from "./grid.mjs";
import { writeSquaresIndex, readSquaresIndex, BUILDER_VERSION, isUpToDate } from "./build-squares.mjs";
import { groupByRelease } from "./publish-squares.mjs";
import { ensureExtract, clipOsmRoads } from "./osm-area.mjs";
import { ringsOf } from "./geofabrik.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(TOOLS, "fixtures", "geofabrik-index-sample.json");
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const index = JSON.parse(await readFile(FIXTURE, "utf8"));
const fresh = () => structuredClone(DEFAULT_STATE);
const tmp = await mkdtemp(join(tmpdir(), "grow-test-"));

// 1. Candidates: England's children, then Wales and Scotland themselves (no children in the
// fixture); Northern Ireland has no extract and is reported missing.
{
  const { areas, missing } = candidateAreas(index, fresh());
  eq(areas.map((a) => a.id), ["greater-london", "greater-manchester", "cheshire", "kent", "surrey", "cornwall", "wales", "scotland"], "candidate areas");
  eq(missing, ["northern-ireland"], "missing countries");
  eq(areas.find((a) => a.id === "cheshire").bbox, [-3.11, 52.96, -1.96, 53.31], "MultiPolygon bbox");
  check(areas.find((a) => a.id === "kent").url.endsWith("/england/kent-latest.osm.pbf"), "extract link from urls.pbf");
  // A country with children uses its children instead of itself.
  const withChild = structuredClone(index);
  withChild.features.push({ type: "Feature", properties: { id: "highlands", parent: "scotland", name: "Highlands", urls: { pbf: "x" } }, geometry: { type: "Polygon", coordinates: [[[-6, 57], [-4, 57], [-4, 58], [-6, 57]]] } });
  eq(candidateAreas(withChild, fresh()).areas.filter((a) => a.phase === "scotland").map((a) => a.id), ["highlands"], "children replace the country");

  // Geofabrik has no Northern Ireland extract: the default phase cuts ireland-and-northern-ireland
  // down to Northern Ireland's bbox, and downloads that extract.
  const withIreland = structuredClone(index);
  withIreland.features.push({ type: "Feature", properties: { id: "ireland-and-northern-ireland", parent: "europe", name: "Ireland and Northern Ireland", urls: { pbf: "https://download.geofabrik.de/europe/ireland-and-northern-ireland-latest.osm.pbf" } }, geometry: { type: "MultiPolygon", coordinates: [[[[-10.61, 51.41], [-5.41, 51.41], [-5.41, 55.41], [-10.61, 55.41], [-10.61, 51.41]]]] } });
  const s = fresh();
  s.phases = ["northern-ireland"].map((id) => DEFAULT_STATE.phases.find((p) => p.id === id));
  const ni = candidateAreas(withIreland, s).areas;
  eq(ni.map((a) => [a.id, a.extract]), [["northern-ireland", "ireland-and-northern-ireland"]], "Northern Ireland from the Ireland extract");
  const niSquares = squaresForArea(ni[0]);
  check(niSquares.every((sq) => sq.lonIdx >= -164 && sq.lonIdx <= -109 && sq.latIdx >= 1080 && sq.latIdx <= 1107), "Northern Ireland squares stay inside its bbox");
  eq(niSquares.length, 56 * 28, "Northern Ireland square count");
  eq(planGrowth({ index: withIreland, state: s, squaresIndex: {}, version: "v1" }).steps[0].extracts, ["ireland-and-northern-ireland"], "Northern Ireland extract");
}

// 2. Order: nearest to Stockport or London (or a finished area) first, England before Wales.
{
  const { areas } = candidateAreas(index, fresh());
  const order = orderAreas(areas, fresh());
  eq(order.map((a) => a.id), ["greater-london", "greater-manchester", "surrey", "cheshire", "kent", "cornwall", "wales", "scotland"], "growth order");
  eq(order[0].nearest, "london", "London area measured from London");
  eq(order[1].nearest, "stockport", "Manchester area measured from Stockport");
  check(Math.abs(distanceKm([53.4, -2.16], [51.49, -0.13]) - 252) < 5, "Stockport to London is about 252 km");

  // Finished areas drop out and count as built: with only a Cornwall seed, Cornwall goes first;
  // once it is finished, the next area is measured from Cornwall too.
  const s = fresh();
  s.seeds = [{ id: "penzance", lat: 50.12, lon: -5.54 }];
  eq(orderAreas(areas, s)[0].id, "cornwall", "nearest to a lone seed");
  recordFinished(s, areas.find((a) => a.id === "cornwall"), { startedAt: "a", finishedAt: "b", squares: 1, built: 1, bytes: 1, extracts: [] });
  const after = orderAreas(areas, s);
  check(!after.some((a) => a.id === "cornwall"), "finished area is not built again");
  check(after[0].nearest === "cornwall" || after[0].nearest === "penzance", "next area measured from what is built");

  // The area in progress comes first, then "first", and "skip" is left out.
  const t = fresh();
  t.current = { id: "kent", startedAt: "x", built: 3 };
  t.first = ["cornwall"];
  t.skip = ["surrey"];
  const o = orderAreas(areas, t).map((a) => a.id);
  eq(o.slice(0, 2), ["kent", "cornwall"], "in progress, then first");
  check(!o.includes("surrey"), "skipped area left out");
}

// 3. Squares of an area: the grid squares its boundary touches, not every square of its bbox.
{
  const rect = { type: "Polygon", coordinates: [[[-0.12, 51.31], [0.02, 51.31], [0.02, 51.38], [-0.12, 51.38], [-0.12, 51.31]]] };
  eq(squaresInGeometry(rect).map(squareId), ["lat1026_lon-3", "lat1026_lon-2", "lat1026_lon-1", "lat1026_lon0", "lat1027_lon-3", "lat1027_lon-2", "lat1027_lon-1", "lat1027_lon0"], "rectangle squares");
  const surrey = candidateAreas(index, fresh()).areas.find((a) => a.id === "surrey");
  const inside = squaresForArea(surrey);
  const all = squaresForArea(surrey, "bbox");
  check(inside.length < all.length && inside.length > 0, `L-shaped area builds fewer squares than its bbox (${inside.length} of ${all.length})`);
  check(!inside.some((sq) => squareId(sq) === "lat1025_lon-8"), "square in the empty corner of the L is not built");

  // Against brute force on a shape with a hole and a slanted edge: every square holding a point
  // of the shape is found, and nothing far from it.
  const shape = { type: "MultiPolygon", coordinates: [
    [[[-1.03, 52.02], [-0.61, 52.07], [-0.72, 52.41], [-1.03, 52.02]]],
    [[[-0.52, 52.02], [-0.21, 52.02], [-0.21, 52.33], [-0.52, 52.33], [-0.52, 52.02]], [[-0.44, 52.09], [-0.29, 52.09], [-0.29, 52.26], [-0.44, 52.26], [-0.44, 52.09]]],
  ] };
  const inRing = (ring, x, y) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const insideShape = (x, y) => ringsOf(shape).reduce((c, r) => (inRing(r, x, y) ? !c : c), false);
  const got = new Set(squaresInGeometry(shape).map(squareId));
  let brute = 0;
  for (let latIdx = 1040; latIdx <= 1048; latIdx++) {
    for (let lonIdx = -21; lonIdx <= -4; lonIdx++) {
      const [a, b] = squareBbox({ latIdx, lonIdx });
      let hit = false;
      for (let i = 0; i <= 30 && !hit; i++) for (let j = 0; j <= 30 && !hit; j++) hit = insideShape(b + (j / 30) / SQUARES_PER_DEGREE, a + (i / 30) / SQUARES_PER_DEGREE);
      if (hit) {
        brute++;
        check(got.has(squareId({ latIdx, lonIdx })), `shape square lat${latIdx}_lon${lonIdx} missing`);
      }
    }
  }
  check(got.size >= brute && got.size <= brute + 4, `shape squares ${got.size}, brute force ${brute}`);
  check(!got.has("lat1044_lon-8"), "square inside the hole is not built");
}

// 4. Extracts: those whose boundary touches a square to build. Surrey's bbox overlaps
// Greater London's, but its boundary does not, so it is not downloaded for London.
{
  const { areas } = candidateAreas(index, fresh());
  const london = areas.find((a) => a.id === "greater-london");
  const squares = squaresForArea(london);
  eq(extractsFor(london, squares, areas), ["greater-london", "kent"], "extracts for Greater London");
  const surrey = areas.find((a) => a.id === "surrey");
  check(surrey.bbox[0] <= london.bbox[2] && london.bbox[0] <= surrey.bbox[2] && surrey.bbox[1] <= london.bbox[3] && london.bbox[1] <= surrey.bbox[3], "fixture: Surrey bbox overlaps London bbox");
  // Only squares still to build count: the Kent border squares already built need no Kent extract.
  const west = squares.filter((sq) => sq.lonIdx < -2);
  eq(extractsFor(london, west, areas), ["greater-london"], "extracts for London's western squares only");
  eq(extractsFor(london, [], areas), [], "no squares to build, no extracts");
  eq(squaresBbox([{ latIdx: 1026, lonIdx: -3 }, { latIdx: 1027, lonIdx: 0 }]), [-0.15, 51.3, 0.05, 51.4], "bbox of squares");
}

// 5. Plan: squares already up to date are skipped, and so are extracts only they needed.
{
  const s = fresh();
  const { areas } = candidateAreas(index, s);
  const london = areas.find((a) => a.id === "greater-london");
  const squaresIndex = {};
  for (const sq of squaresForArea(london)) if (sq.lonIdx >= -2) squaresIndex[squareId(sq)] = { version: "v1", builder: BUILDER_VERSION };
  const plan = planGrowth({ index, state: s, squaresIndex, version: "v1", perRun: 2 });
  eq(plan.steps.map((p) => p.area.id), ["greater-london", "greater-manchester"], "plan areas");
  eq(plan.steps[0].extracts, ["greater-london"], "up-to-date border squares need no Kent extract");
  check(plan.steps[0].todo.length === plan.steps[0].squares.length - Object.keys(squaresIndex).length, "todo leaves out up-to-date squares");
  const stale = planGrowth({ index, state: s, squaresIndex, version: "v2", perRun: 1 });
  check(stale.steps[0].todo.length === stale.steps[0].squares.length, "a new tile version rebuilds");
  check(!isUpToDate({ version: "v1", builder: "old" }, "v1"), "a new builder version rebuilds");
}

// 6. Growth state: finished areas are recorded with times, squares and bytes, and saved.
{
  const s = fresh();
  s.current = { id: "kent", startedAt: "2026-11-13T01:00:00Z", built: 10 };
  const kent = candidateAreas(index, s).areas.find((a) => a.id === "kent");
  recordFinished(s, kent, { startedAt: s.current.startedAt, finishedAt: "2026-11-13T02:00:00Z", squares: 300, built: 280, bytes: 123456, extracts: ["kent", "greater-london"] });
  eq(s.current, null, "current cleared");
  eq(s.finished, [{ id: "kent", name: "Kent", phase: "england", startedAt: "2026-11-13T01:00:00Z", finishedAt: "2026-11-13T02:00:00Z", squares: 300, built: 280, bytes: 123456, extracts: ["kent", "greater-london"] }], "finished record");
  recordFinished(s, kent, { startedAt: "x", finishedAt: "y", squares: 1, built: 1, bytes: 1, extracts: [] });
  check(s.finished.length === 1, "an area is recorded once");
  const file = join(tmp, "growth.json");
  await writeGrowth(s, file);
  const back = await readGrowth(file);
  eq(back.finished[0].id, "kent", "state saved and read back");
  eq((await readGrowth(join(tmp, "none.json"))).phases, DEFAULT_STATE.phases, "defaults when there is no state file");
  const committed = JSON.parse(await readFile(join(TOOLS, "..", "data", "published", "growth.json"), "utf8"));
  eq(committed.phases.map((p) => (typeof p === "string" ? p : p.id)), ["england", "wales", "scotland", "northern-ireland"], "committed growth.json phases");
}

// 7. Row releases and URLs.
{
  eq(squareRelease({ latIdx: 1068, lonIdx: -44 }), "squares-lat1068", "release tag");
  eq(squareUrl({ latIdx: 1068, lonIdx: -44 }), "https://github.com/phuk-prog/Drivemate-map/releases/download/squares-lat1068/lat1068_lon-44.dmap.gz", "square URL");
  eq(squareRelease({ latIdx: -5, lonIdx: 3 }), "squares-lat-5", "negative row tag");
  eq(parseSquareId("lat1068_lon-44"), { latIdx: 1068, lonIdx: -44 }, "parse id");
  eq(parseSquareId("stockport"), null, "not a square id");
  eq(groupByRelease(["lat1068_lon-44.dmap.gz", "lat1068_lon-43.dmap.gz", "lat1069_lon-44.dmap.gz", "index.json"]),
    { "squares-lat1068": ["lat1068_lon-44.dmap.gz", "lat1068_lon-43.dmap.gz"], "squares-lat1069": ["lat1069_lon-44.dmap.gz"] }, "files grouped by row");
  const dir = join(tmp, "squares");
  await writeSquaresIndex({ "lat1026_lon-3": { version: "v1", builder: BUILDER_VERSION, bytes: 5 } }, dir);
  const written = await readSquaresIndex(dir);
  eq(written["lat1026_lon-3"].release, "squares-lat1026", "index entry release");
  eq(written["lat1026_lon-3"].url, "https://github.com/phuk-prog/Drivemate-map/releases/download/squares-lat1026/lat1026_lon-3.dmap.gz", "index entry url");
  // Every row of England fits in one release: at most 1000 squares per row.
  const lonSquares = (1.8 - -5.8) * SQUARES_PER_DEGREE;
  check(lonSquares < 1000, "a row of England fits in one release");
}

// 8. Extract downloads: only when Geofabrik's Last-Modified changed or our copy is missing.
{
  const cache = join(tmp, "osm");
  const calls = [];
  let lastModified = "Thu, 12 Nov 2026 20:00:00 GMT";
  const fakeFetch = async (url, opts = {}) => {
    calls.push(opts.method ?? "GET");
    return new Response(opts.method === "HEAD" ? null : "pbf-bytes", { headers: { "last-modified": lastModified } });
  };
  const record = {};
  const quiet = () => {};
  await ensureExtract("kent", cache, { record, url: "https://example.invalid/kent.osm.pbf", fetchFn: fakeFetch, log: quiet });
  eq(calls, ["HEAD", "GET"], "first use downloads");
  eq(record.kent.lastModified, lastModified, "Last-Modified recorded");
  eq(record.kent.bytes, 9, "size recorded");
  calls.length = 0;
  await ensureExtract("kent", cache, { record, url: "https://example.invalid/kent.osm.pbf", fetchFn: fakeFetch, log: quiet });
  eq(calls, ["HEAD"], "unchanged extract is not downloaded again");
  calls.length = 0;
  lastModified = "Fri, 13 Nov 2026 20:00:00 GMT";
  await ensureExtract("kent", cache, { record, url: "https://example.invalid/kent.osm.pbf", fetchFn: fakeFetch, log: quiet });
  eq(calls, ["HEAD", "GET"], "changed extract is downloaded");
  calls.length = 0;
  await rm(join(cache, "kent.osm.pbf"));
  await ensureExtract("kent", cache, { record, url: "https://example.invalid/kent.osm.pbf", fetchFn: fakeFetch, log: quiet });
  eq(calls, ["HEAD", "GET"], "missing copy is downloaded");
  eq((await readdir(cache)).sort(), ["kent.osm.pbf"], "no partial files left");
}

// 9. Clipping merged roads to an area keeps exactly the roads with a node inside it.
{
  const coords = new Map([[1, [51.0, 0.0]], [2, [51.0, 0.01]], [3, [52.0, 0.0]], [4, [52.0, 0.01]]]);
  const clipped = clipOsmRoads({
    ways: [{ id: 10, nodes: [1, 2] }, { id: 11, nodes: [2, 3] }, { id: 12, nodes: [3, 4] }],
    relations: [{ id: 5, members: [{ type: "node", role: "via", ref: 2 }] }, { id: 6, members: [{ type: "node", role: "via", ref: 4 }] }],
    coords,
    cameras: [{ lat: 51.0, lon: 0.005 }, { lat: 52.0, lon: 0.005 }],
  }, [-0.1, 50.9, 0.1, 51.1]);
  eq(clipped.ways.map((w) => w.id), [10, 11], "roads with a node inside");
  eq([...clipped.coords.keys()].sort(), [1, 2, 3], "all nodes of kept roads");
  eq(clipped.relations.map((r) => r.id), [5], "restrictions at kept nodes");
  eq(clipped.cameras.length, 1, "cameras inside");
}

// 10. Dry run of the real command with the fixture: prints the plan, downloads and writes nothing.
{
  const state = join(tmp, "dry-growth.json");
  await writeFile(state, JSON.stringify(DEFAULT_STATE, null, 2) + "\n");
  const before = await readFile(state, "utf8");
  const squaresDir = join(tmp, "dry-squares");
  await writeSquaresIndex({ "lat1026_lon-10": { version: "fixture-v1", builder: BUILDER_VERSION, bytes: 1 } }, squaresDir);
  const indexBefore = await readFile(join(squaresDir, "index.json"), "utf8");
  const out = execFileSync(process.execPath, [join(TOOLS, "grow.mjs"), "--dry-run", "--no-head"], {
    encoding: "utf8",
    env: { ...process.env, GEOFABRIK_INDEX: FIXTURE, GROW_STATE: state, SQUARES_DIR: squaresDir, GROW_TILE_VERSION: "fixture-v1", GROW_PER_RUN: "2", GROW_MINUTES: "30" },
  });
  const has = (text) => check(out.includes(text), `dry run output lacks "${text}":\n${out}`);
  has("Growth plan (dry run");
  has("tile version fixture-v1");
  has("per run: up to 2 area(s) within 30 min");
  has("northern-ireland: no Geofabrik extract");
  has('1. greater-london "Greater London" (england), 2 km from london');
  has("144 squares touch the bbox, 144 to publish, 1 already up to date, 143 to build");
  has("extracts (2): greater-london, kent");
  has("releases: 8 rows (squares-lat1026 .. squares-lat1033)");
  has('2. greater-manchester "Greater Manchester" (england), 15 km from stockport');
  has("extracts (3): greater-manchester, cheshire, wales");
  has("after that: surrey, cheshire, kent, cornwall, wales, scotland");
  eq(await readFile(state, "utf8"), before, "dry run leaves the state file alone");
  eq(await readFile(join(squaresDir, "index.json"), "utf8"), indexBefore, "dry run leaves the squares index alone");
  eq((await readdir(squaresDir)).sort(), ["index.json"], "dry run builds no squares");
}

await rm(tmp, { recursive: true, force: true });
if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("all growth checks passed");
