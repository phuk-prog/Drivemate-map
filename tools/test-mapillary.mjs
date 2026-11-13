// Tests the Mapillary review with hand-made data in Mapillary's documented response shape
// (tools/fixtures/mapillary-map-features-sample.json) and a small hand-made DMAP square:
// sign values and units, tiling and paging, retries and tile splitting, token redaction, matching
// within 20 m, the two flag kinds, the GeoJSON output, and which files are written or kept.
// Needs no network and no token. Usage: node tools/test-mapillary.mjs

import { readFile, writeFile, mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDmap, readDmap, toFixed7 } from "./dmap.mjs";
import { parseSpeedSign, signUnit, tileBbox, fetchSpeedSigns, featuresUrl, redact, speedSignObjectValues, MapillaryError } from "./mapillary.mjs";
import { reviewSquare, edgeIndex, nearestEdge, toGeoJson, runReview, squaresInScope, outputNames, NOTE } from "./review-mapillary.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(await readFile(join(TOOLS, "fixtures", "mapillary-map-features-sample.json"), "utf8"));
const TOKEN = "MLY|1234|SECRETSECRET";
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const near = (a, b, tol, msg) => check(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b}`);
const noSleep = async () => {};

// ---- sign values and units ----
{
  const london = parseSpeedSign("regulatory--maximum-speed-limit-30--g1", 51.5, -0.12);
  eq([london.value, london.unit, london.mph], [30, "mph", 30], "London sign is 30 mph");
  near(london.kmh, 48.28, 0.01, "30 mph in km/h");
  eq(parseSpeedSign("regulatory--maximum-speed-limit-50--g3", 48.85, 2.35), { value: 50, unit: "km/h", kmh: 50, mph: null }, "Paris sign is 50 km/h");
  eq(parseSpeedSign("regulatory--maximum-speed-limit-20--g2", 53.4, -2.2).unit, "mph", "Stockport is mph");
  eq(signUnit(54.6, -5.93), "mph", "Belfast is mph");
  eq(signUnit(57.5, -7.3), "mph", "Outer Hebrides are mph");
  eq(signUnit(49.45, -2.55), "mph", "Guernsey is mph");
  eq(signUnit(53.35, -6.26), "km/h", "Dublin is km/h");
  eq(signUnit(52.25, -7.1), "km/h", "Waterford is km/h");
  eq(parseSpeedSign("regulatory--end-of-maximum-speed-limit-30--g1", 51.5, -0.12), null, "end-of-limit sign is not a limit");
  eq(parseSpeedSign("regulatory--maximum-speed-limit-zone-20--g1", 51.5, -0.12), null, "other sign shapes are ignored");
  eq(parseSpeedSign("warning--road-bump--g1", 51.5, -0.12), null, "warning sign is not a limit");
  eq(parseSpeedSign("regulatory--maximum-speed-limit-999--g1", 51.5, -0.12), null, "absurd value is ignored");
  eq(parseSpeedSign(undefined, 51.5, -0.12), null, "missing value is ignored");
  const ov = speedSignObjectValues();
  check(ov.includes("regulatory--maximum-speed-limit-30--g1") && ov.includes("regulatory--maximum-speed-limit-70--g5"), "server filter asks for 30 and 70 signs");
}

// ---- tiling ----
{
  const square = [-2.25, 53.4, -2.2, 53.45];
  const tiles = tileBbox(square);
  eq(tiles.length, 25, "a 0.05 degree square is 25 tiles");
  eq(tiles[0], [-2.25, 53.4, -2.24, 53.41], "first tile");
  eq(tiles[24], [-2.21, 53.44, -2.2, 53.45], "last tile ends at the square's corner");
  check(tiles.every((t) => t[2] - t[0] <= 0.0100001 && t[3] - t[1] <= 0.0100001), "no tile is larger than 0.01 degrees");
  const area = tiles.reduce((s, t) => s + (t[2] - t[0]) * (t[3] - t[1]), 0);
  near(area, 0.05 * 0.05, 1e-9, "tiles cover the square exactly");
  const odd = tileBbox([0, 0, 0.025, 0.01]);
  eq(odd.map((t) => t[2]), [0.01, 0.02, 0.025], "a box that is not a whole number of tiles ends with a narrower tile");
  eq(tileBbox([0, 0, 0.004, 0.004]).length, 1, "a small box is one tile");
}

// ---- a fake Mapillary server, answering from the fixture's features with paging ----
function fakeServer({ pageSize = 2, dropTokenInNext = false, fail = () => 0 } = {}) {
  const log = [];
  const fetch = async (url) => {
    const u = new URL(url);
    log.push(u);
    const failStatus = fail(u, log.length);
    if (failStatus) return { ok: false, status: failStatus, json: async () => ({}), text: async () => `error for ${url}` };
    if (u.searchParams.get("access_token") !== TOKEN) return { ok: false, status: 401, json: async () => ({}), text: async () => "no token" };
    const [minLon, minLat, maxLon, maxLat] = u.searchParams.get("bbox").split(",").map(Number);
    // Inclusive edges, like a real bounding-box search: a sign on a tile edge comes back from each tile.
    const all = FIXTURE.data.filter((f) => {
      const [lon, lat] = f.geometry.coordinates;
      return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
    });
    const after = Number(u.searchParams.get("after") ?? 0);
    const limit = Math.min(Number(u.searchParams.get("limit")), pageSize);
    const data = all.slice(after, after + limit);
    const body = { data };
    if (after + limit < all.length) {
      const next = new URL(url);
      next.searchParams.set("after", String(after + limit));
      if (dropTokenInNext) next.searchParams.delete("access_token");
      body.paging = { cursors: { after: String(after + limit) }, next: next.toString() };
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, log };
}

const SQUARE_BBOX = [-2.25, 53.4, -2.2, 53.45]; // lat1068_lon-45 in Mapillary order

// ---- tiling, paging, dedupe and bbox filter ----
{
  const server = fakeServer({ pageSize: 2 });
  const sleeps = [];
  const signs = await fetchSpeedSigns(SQUARE_BBOX, { token: TOKEN, fetch: server.fetch, sleep: async (ms) => sleeps.push(ms) });
  eq(signs.map((s) => s.id.slice(-2)), ["01", "02", "03", "04", "05", "06", "07", "10"], "speed-limit signs in the square, once each, sorted");
  const tilesAsked = new Set(server.log.map((u) => u.searchParams.get("bbox")));
  eq(tilesAsked.size, 25, "every tile was asked for");
  check(server.log.some((u) => u.searchParams.get("after")), "paging.next was followed");
  check(server.log.length > 25, "more requests than tiles because of paging");
  eq(signs.requests, server.log.length, "request count is reported");
  eq(sleeps.length, server.log.length - 1, "a polite delay before every request but the first");
  check(sleeps.every((ms) => ms === 250), "polite delay is 250 ms");
  const first = server.log[0];
  eq(first.searchParams.get("fields"), "id,object_value,geometry,first_seen_at,last_seen_at", "fields asked for");
  check(first.searchParams.get("object_values").split(",").includes("regulatory--maximum-speed-limit-30--g1"), "object_values filter is sent");
  const s1 = signs[0];
  eq([s1.value, s1.unit, s1.lat, s1.lon], [30, "mph", 53.41005, -2.235], "parsed sign 1");

  const dropped = fakeServer({ pageSize: 1, dropTokenInNext: true });
  const again = await fetchSpeedSigns(SQUARE_BBOX, { token: TOKEN, fetch: dropped.fetch, sleep: noSleep });
  eq(again.map((s) => s.id), signs.map((s) => s.id), "paging works when paging.next has no token");

  const unfiltered = fakeServer({ pageSize: 50 });
  await fetchSpeedSigns(SQUARE_BBOX, { token: TOKEN, fetch: unfiltered.fetch, sleep: noSleep, objectValues: null });
  check(!unfiltered.log[0].searchParams.has("object_values"), "objectValues null sends no filter");
}

// ---- retries, back-off, splitting, refused tokens, redaction ----
{
  const once = fakeServer({ pageSize: 50, fail: (u, n) => (n === 1 ? 503 : 0) });
  const sleeps = [];
  const signs = await fetchSpeedSigns(SQUARE_BBOX, { token: TOKEN, fetch: once.fetch, sleep: async (ms) => sleeps.push(ms) });
  eq(signs.length, 8, "a failed request is retried");
  check(sleeps.includes(2000), "first retry waits 2 s");

  const bigTile = "-2.25,53.4,-2.24,53.41";
  const splitting = fakeServer({ pageSize: 50, fail: (u) => (u.searchParams.get("bbox") === bigTile ? 500 : 0) });
  const split = await fetchSpeedSigns(SQUARE_BBOX, { token: TOKEN, fetch: splitting.fetch, sleep: noSleep, retries: 1 });
  eq(split.length, 8, "a tile that keeps returning HTTP 500 is split and still read");
  check(splitting.log.some((u) => u.searchParams.get("bbox") === "-2.25,53.4,-2.245,53.405"), "split tile asked as a quarter");

  const always = fakeServer({ pageSize: 50, fail: () => 500 });
  let err = null;
  try {
    await fetchSpeedSigns([-2.25, 53.4, -2.24, 53.41], { token: TOKEN, fetch: always.fetch, sleep: noSleep, retries: 1 });
  } catch (e) {
    err = e;
  }
  check(err instanceof MapillaryError && err.status === 500, "a tile that never answers fails in the end");
  check(err && !err.message.includes("SECRET"), "error messages never contain the token");

  const refused = fakeServer({ fail: () => 401 });
  err = null;
  try {
    await fetchSpeedSigns(SQUARE_BBOX, { token: TOKEN, fetch: refused.fetch, sleep: noSleep });
  } catch (e) {
    err = e;
  }
  eq([err?.status, refused.log.length], [401, 1], "a refused token fails at once, without retries");
  check(err && !err.message.includes("SECRET"), "401 message never contains the token");
  const url = featuresUrl(SQUARE_BBOX, TOKEN);
  check(!redact(url).includes("SECRET") && redact(url).includes("access_token=***"), "redact hides the token in URLs");
  check(!redact("token MLY|1234|SECRETSECRET").includes("SECRET"), "redact hides a bare token");
  let noToken = null;
  try {
    await fetchSpeedSigns(SQUARE_BBOX, {});
  } catch (e) {
    noToken = e;
  }
  check(noToken !== null, "no token is an error");
}

// ---- a hand-made square ----
const P = (lat, lon) => [toFixed7(lat), toFixed7(lon)];
function squareMap() {
  const strings = ["", "Wellington Road", "A6", "Station Road", "Hall Lane", "Private Drive"];
  const edge = (lat, lon1, lon2, maxspeed, name, ref = 0, flags = 0, roadClass = 6) => ({
    from: 0, to: 0, roadClass, flags, maxspeed, name, ref, points: [P(lat, lon1), P(lat, (lon1 + lon2) / 2), P(lat, lon2)],
  });
  const edges = [
    edge(53.41, -2.24, -2.23, 48, 1, 2, 0, 3), // Wellington Road (A6), 30 mph in OSM
    edge(53.42, -2.24, -2.21, 0, 3), // Station Road, no maxspeed in OSM
    edge(53.43, -2.24, -2.23, 64, 4), // Hall Lane, 40 mph in OSM
    edge(53.44, -2.24, -2.23, 0, 5, 0, 1 << 4, 7), // Private Drive, no motor access
  ];
  const nodes = [{ lat: P(53.41, -2.24)[0], lon: P(53.41, -2.24)[1] }];
  const bbox = [toFixed7(53.4), toFixed7(-2.25), toFixed7(53.45), toFixed7(-2.2)];
  return readDmap(writeDmap({ bbox, nodes, edges, lines: [], polygons: [], labels: [], strings }));
}

// ---- matching within 20 m and the two flag kinds ----
const map = squareMap();
const signs = await fetchSpeedSigns(SQUARE_BBOX, { token: TOKEN, fetch: fakeServer({ pageSize: 50 }).fetch, sleep: noSleep });
{
  const idx = edgeIndex(map);
  const hit = nearestEdge(idx, 53.41005, -2.235);
  eq(hit?.edgeIndex, 0, "a sign 5.6 m from Wellington Road matches it");
  near(hit.distance, 5.56, 0.05, "distance to Wellington Road");
  eq(nearestEdge(idx, 53.4303, -2.235), null, "a sign 33 m from Hall Lane matches nothing");
  eq(nearestEdge(idx, 53.43015, -2.233)?.edgeIndex, 2, "a sign 16.7 m from Hall Lane matches it");
  eq(nearestEdge(idx, 53.4101, -2.2402)?.edgeIndex, 0, "a sign past the end of a road, within 20 m, matches it");
  eq(nearestEdge(idx, 53.41, -2.2415), null, "a sign 100 m past the end of a road matches nothing");
  eq(nearestEdge(idx, 53.44005, -2.235), null, "roads with no motor access are never matched");

  const flags = reviewSquare(map, signs);
  const summary = flags.map((f) => [f.kind, f.road, f.ours_kmh, f.sign_kmh, f.sign_mph, f.sign.id.slice(-2), f.signs]).sort();
  eq(summary, [
    ["SPEED_LIMIT", "Hall Lane", 64, 48, 30, "06", 1],
    ["SPEED_LIMIT", "Wellington Road (A6)", 48, 32, 20, "02", 2],
    ["SPEED_LIMIT_MISSING", "Station Road", 0, 48, 30, "04", 1],
    ["SPEED_LIMIT_MISSING", "Station Road", 0, 80, 50, "10", 1],
  ], "flags: two differences (one with two signs) and two missing limits; 30 mph on a 48 km/h road is not flagged");
  eq(reviewSquare(map, []), [], "no signs, no flags");
  const kmh = signs.map((s) => ({ ...s, unit: "km/h", kmh: s.value, mph: null }));
  const kmhFlags = reviewSquare(map, kmh).map((f) => [f.kind, f.road, f.sign_kmh]).sort();
  check(kmhFlags.some((f) => f[0] === "SPEED_LIMIT" && f[1] === "Wellington Road (A6)" && f[2] === 30), "km/h signs are compared without conversion");
  const within = reviewSquare(map, [{ ...signs[0], kmh: 50 }]);
  eq(within.length, 0, "a sign within 2 km/h of our limit is not flagged");
  const beyond = reviewSquare(map, [{ ...signs[0], kmh: 50.1 }]);
  eq(beyond.length, 1, "a sign more than 2 km/h from our limit is flagged");
}

// ---- GeoJSON ----
{
  const flags = reviewSquare(map, signs);
  const text = toGeoJson(flags);
  const fc = JSON.parse(text);
  eq(fc.type, "FeatureCollection", "GeoJSON is a FeatureCollection");
  eq(fc.features.length, 4, "one feature per flag");
  eq(text.split("\n").length, 4 + 3, "one feature per line");
  check(fc.features.every((f) => f.type === "Feature" && f.geometry.type === "Point" && f.geometry.coordinates.length === 2), "features are points");
  check(fc.features.every((f) => f.geometry.coordinates.every((c) => Number(c.toFixed(6)) === c)), "coordinates rounded to 6 decimals");
  const keys = ["kind", "ours_kmh", "sign_kmh", "sign_mph", "road", "mapillary_feature_id", "mapillary_url", "osm_edit_url", "note"];
  check(fc.features.every((f) => keys.every((k) => k in f.properties)), "every feature has the required properties");
  check(fc.features.every((f) => f.properties.note === NOTE && NOTE === "Check the Mapillary photo, then edit OpenStreetMap by hand."), "note text");
  const w = fc.features.find((f) => f.properties.road === "Wellington Road (A6)");
  eq(w.geometry.coordinates, [-2.238, 53.41008], "feature sits at the sign");
  eq(w.properties.mapillary_feature_id, "1000000000000002", "Mapillary feature id");
  eq(w.properties.mapillary_url, "https://www.mapillary.com/app/?lat=53.41008&lng=-2.238&z=18&mapFeatureKey=1000000000000002", "Mapillary link");
  eq(w.properties.osm_edit_url, "https://www.openstreetmap.org/edit#map=19/53.41008/-2.238", "OpenStreetMap editor link");
  eq([w.properties.ours_kmh, w.properties.sign_kmh, w.properties.sign_mph, w.properties.signs], [48, 32, 20, 2], "Wellington Road values");
  eq(w.properties.title, "Wellington Road (A6): sign 20 mph, map 30 mph (48 km/h)", "title");
  eq(fc.features.map((f) => f.properties.kind), ["SPEED_LIMIT", "SPEED_LIMIT", "SPEED_LIMIT_MISSING", "SPEED_LIMIT_MISSING"], "features sorted by kind");
  const lats = fc.features.filter((f) => f.properties.kind === "SPEED_LIMIT").map((f) => f.geometry.coordinates[1]);
  eq(lats, [...lats].sort((a, b) => b - a), "then north to south");
  const shuffled = reviewSquare(map, [...signs].reverse());
  eq(toGeoJson(shuffled), text, "output does not depend on the order Mapillary returns signs");
  eq(toGeoJson([]), '{"type":"FeatureCollection","features":[]}\n', "empty FeatureCollection");
  check(!text.includes("seen_at"), "no dates that change every week");
}

// ---- scope and output names ----
{
  const regions = { squareAreas: [{ id: "stockport", bbox: [-2.25, 53.34, -2.07, 53.46] }, { id: "london", bbox: [-0.55, 51.28, 0.3, 51.7] }] };
  const index = { "lat1068_lon-45": { release: "squares-lat1068" }, "lat1030_lon-3": { release: "squares-lat1030" }, "lat1100_lon-30": { release: "squares-lat1100" }, "not-a-square": {} };
  eq(squaresInScope(index, regions), ["lat1030_lon-3", "lat1068_lon-45"], "areas scope: squares of the square areas");
  eq(squaresInScope(index, regions, "all"), ["lat1030_lon-3", "lat1068_lon-45", "lat1100_lon-30"], "all scope: every published square");
  eq(squaresInScope(index, regions, "areas", ["lat1100_lon-30"]), ["lat1100_lon-30"], "--squares picks squares");
  eq([...outputNames(["lat1068_lon-45", "lat1030_lon-3", "lat1100_lon-30"], regions)], [["lat1068_lon-45", "stockport"], ["lat1030_lon-3", "london"], ["lat1100_lon-30", "lat1100_lon-30"]], "output names");
}

// ---- a full run on files: written, unchanged, kept on no data, kept on failure ----
const tmp = await mkdtemp(join(tmpdir(), "mapillary-test-"));
try {
  const squaresDir = join(tmp, "squares");
  const outDir = join(tmp, "review");
  await mkdir(squaresDir);
  const raw = writeDmap(squareMap());
  await writeFile(join(squaresDir, "lat1068_lon-45.dmap"), raw);
  await writeFile(join(squaresDir, "lat1100_lon-30.dmap"), raw);
  const regions = { squareAreas: [{ id: "stockport", bbox: [-2.25, 53.34, -2.07, 53.46] }] };
  const fetchSigns = (bbox) => fetchSpeedSigns(bbox, { token: TOKEN, fetch: fakeServer({ pageSize: 50 }).fetch, sleep: noSleep });
  const quiet = () => {};
  const ids = ["lat1068_lon-45", "lat1069_lon-45"]; // the second is in scope but not downloaded
  const r1 = await runReview({ ids, regions, squaresDir, outDir, fetchSigns, log: quiet });
  eq([r1.written, r1.kept, r1.failed, r1.flags, r1.signs], [["stockport"], [], [], 4, 8], "first run writes stockport.geojson");
  eq(await readdir(outDir), ["stockport.geojson"], "only the area file is written");
  const first = await readFile(join(outDir, "stockport.geojson"), "utf8");
  eq(JSON.parse(first).features.length, 4, "file holds the flags");
  await runReview({ ids, regions, squaresDir, outDir, fetchSigns, log: quiet });
  eq(await readFile(join(outDir, "stockport.geojson"), "utf8"), first, "a second run gives the same bytes");

  const empty = await runReview({ ids, regions, squaresDir, outDir, fetchSigns: async () => [], log: quiet });
  eq([empty.written, empty.kept], [[], ["stockport"]], "no signs at all: file kept");
  eq(await readFile(join(outDir, "stockport.geojson"), "utf8"), first, "no signs at all: flags not wiped");

  const broken = await runReview({ ids, regions, squaresDir, outDir, fetchSigns: async () => { throw new MapillaryError("HTTP 500", 500); }, log: quiet });
  eq([broken.kept, broken.failed], [["stockport"], ["lat1068_lon-45"]], "a failed square keeps its area file and is reported");
  let fatal = null;
  try {
    await runReview({ ids, regions, squaresDir, outDir, fetchSigns: async () => { throw new MapillaryError("HTTP 401", 401); }, log: quiet });
  } catch (e) {
    fatal = e;
  }
  check(fatal && /MAPILLARY_TOKEN/.test(fatal.message), "a refused token stops the run with a clear message");

  const other = await runReview({ ids: ["lat1100_lon-30"], regions, squaresDir, outDir, log: quiet,
    fetchSigns: async () => [{ id: "77", lat: 55.0, lon: -1.5, value: 30, unit: "mph", kmh: 48.28, mph: 30 }] });
  eq(other.written, ["lat1100_lon-30"], "a square outside every area gets its own file");
  eq(await readFile(join(outDir, "lat1100_lon-30.geojson"), "utf8"), toGeoJson([]), "signs but no matches: empty FeatureCollection");
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("all Mapillary review checks passed");
