// Extracts turn restrictions, lane tags and road warnings from an OpenStreetMap .osm.pbf extract,
// and caches them for the map builder:
//   data/osm-cache/restrictions/<name>.json  (same records the Overpass fetch made)
//   data/osm-cache/lanes/<name>.json         (same ways the Overpass fetch made)
//   data/osm-cache/warnings/<name>.json      (speed cameras, level crossings, roads under construction)
//   data/osm-cache/speed/<name>.json         (maxspeed ways, thinned geometry, see tools/speed.mjs)
// Build-time only: the app never reads OpenStreetMap files. Our own code.
//
// Usage: node tools/osm-extract.mjs --pbf=greater-london.osm.pbf --name=london --bbox=-0.55,51.28,0.30,51.70
//
// A .osm.pbf file lists nodes, then ways, then relations, so this reads the file three times:
//   1. relations: find the simple turn restrictions (one from way, one via node, one to way)
//   2. ways: keep the from and to ways, and the ways that carry lane tags
//   3. nodes: look up the coordinates of the nodes those ways use
// Memory stays small, because only the nodes that are needed are kept.

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readPbf } from "./osm-pbf.mjs";
import { parseMaxspeed, parseOneway } from "./speed.mjs";
import { RESTRICTION_NO, RESTRICTION_ONLY, WARNING_SPEED_CAMERA, WARNING_LEVEL_CROSSING, WARNING_ROADWORKS } from "./dmap.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEED_KEYS = [["maxspeed", "both"], ["maxspeed:forward", "forward"], ["maxspeed:backward", "backward"]];
const SPEED_GEOM_POINTS = 12; // a maxspeed way keeps at most this many points, always the first and last
const LANE_KEYS = ["turn:lanes", "turn:lanes:forward", "turn:lanes:backward"];

// The nodes next to the via node on a way: the point before, the via node, the point after.
function around(refs, viaId) {
  const i = refs.indexOf(viaId);
  return i < 0 ? null : refs.slice(Math.max(0, i - 1), i + 2);
}

// Picks at most SPEED_GEOM_POINTS items evenly along a list, always keeping the first and last.
// Keeps memory low: a country has hundreds of thousands of maxspeed ways.
function thin(refs) {
  if (refs.length <= SPEED_GEOM_POINTS) return Array.from(refs);
  const out = [];
  for (let i = 0; i < SPEED_GEOM_POINTS; i++) out.push(refs[Math.round((i * (refs.length - 1)) / (SPEED_GEOM_POINTS - 1))]);
  return out;
}

// bbox is [minLon, minLat, maxLon, maxLat] in degrees. Returns { restrictions, laneWays, stats }.
export async function extractFromPbf(path, bbox) {
  const minLat = Math.round(bbox[1] * 1e7);
  const minLon = Math.round(bbox[0] * 1e7);
  const maxLat = Math.round(bbox[3] * 1e7);
  const maxLon = Math.round(bbox[2] * 1e7);
  const inBox = (p) => p[0] >= minLat && p[0] <= maxLat && p[1] >= minLon && p[1] <= maxLon;

  const stats = {
    restrictionRelations: 0,
    restrictionsSimple: 0,
    restrictionsMissingGeometry: 0,
    restrictionsOutsideBox: 0,
    laneWaysFound: 0,
    laneWaysMissingGeometry: 0,
    laneWaysOutsideBox: 0,
    speedWaysFound: 0,
    speedValuesDropped: 0,
    speedWaysMissingGeometry: 0,
    speedWaysOutsideBox: 0,
    warningsSpeedCamera: 0,
    warningsLevelCrossing: 0,
    warningsRoadworks: 0,
    roundaboutWaysFound:0,
    roundaboutWaysMissingGeometry:0,
    roundaboutWaysOutsideBox:0,
  };

  // Pass 1: restriction relations.
  const relations = [];
  const neededWays = new Set();
  const neededNodes = new Set();
  await readPbf(path, {
    onRelation(rel, block) {
      const typeKey = block.find("type");
      const restrictionKey = block.find("restriction");
      if (typeKey < 0 || restrictionKey < 0) return;
      let isRestriction = false;
      let text = null;
      for (let k = 0; k < rel.keys.length; k++) {
        if (rel.keys[k] === typeKey && block.str(rel.vals[k]) === "restriction") isRestriction = true;
        else if (rel.keys[k] === restrictionKey) text = block.str(rel.vals[k]);
      }
      if (!isRestriction || !text) return;
      const kind = text.startsWith("only_") ? RESTRICTION_ONLY : text.startsWith("no_") ? RESTRICTION_NO : 0;
      if (!kind) return;
      stats.restrictionRelations++;

      const from = [];
      const to = [];
      const via = [];
      for (let m = 0; m < rel.memids.length; m++) {
        const role = block.str(rel.roles[m]);
        const type = rel.types[m]; // 0 node, 1 way, 2 relation
        if (role === "from" && type === 1) from.push(rel.memids[m]);
        else if (role === "to" && type === 1) to.push(rel.memids[m]);
        else if (role === "via") via.push({ type, id: rel.memids[m] });
      }
      // Simple restrictions only: one from way, one to way, one via node.
      if (from.length !== 1 || to.length !== 1 || via.length !== 1 || via[0].type !== 0) return;
      stats.restrictionsSimple++;
      relations.push({ kind, fromWay: from[0], toWay: to[0], viaNode: via[0].id });
      neededWays.add(from[0]);
      neededWays.add(to[0]);
    },
  });

  // Pass 2: the from and to ways, and the ways with lane tags.
  const wayRefs = new Map();
  const laneRaw = [];
  const roundaboutRaw = []; // original OSM junction tags, unavailable in basic vector tiles
  const constructionNodes = []; // one middle node per road under construction
  const speedRaw = [];
  await readPbf(path, {
    onWay(way, block) {
      // Roads under construction (highway=construction) become one roadworks warning each.
      const constructionVal = block.find("construction");
      if (constructionVal >= 0) {
        const highwayKey = block.find("highway");
        for (let k = 0; k < way.keys.length; k++) {
          if (way.keys[k] === highwayKey && way.vals[k] === constructionVal && way.refs.length > 0) {
            constructionNodes.push(way.refs[Math.floor(way.refs.length / 2)]);
            break;
          }
        }
      }
      // Speed limits: highway ways with a maxspeed tag (plain, forward or backward).
      const speedIndexes = SPEED_KEYS.map(([k]) => block.find(k));
      if (speedIndexes.some((i) => i >= 0) && way.refs.length >= 2) {
        const highwayKey = block.find("highway");
        const onewayKey = block.find("oneway");
        let highway = false;
        let oneway = 0;
        const found = [];
        for (let k = 0; k < way.keys.length; k++) {
          const key = way.keys[k];
          const at = speedIndexes.indexOf(key);
          if (at >= 0) found.push([SPEED_KEYS[at][1], block.str(way.vals[k])]);
          else if (key === highwayKey) highway = true;
          else if (key === onewayKey) oneway = parseOneway(block.str(way.vals[k]));
        }
        if (highway && found.length > 0) {
          stats.speedWaysFound++;
          const parsed = [];
          for (const [direction, text] of found) {
            const p = parseMaxspeed(text);
            if (p) parsed.push({ direction, value: p.value, unit: p.unit });
            else stats.speedValuesDropped++;
          }
          if (parsed.length > 0) speedRaw.push({ way: way.id, oneway, parsed, refs: thin(way.refs) });
        }
      }
      const junctionKey = block.find('junction');
      const highwayForCircle = block.find('highway');
      if(junctionKey>=0&&highwayForCircle>=0&&way.refs.length>=2&&way.keys.includes(highwayForCircle)){
        for(let k=0;k<way.keys.length;k++){
          if(way.keys[k]!==junctionKey)continue;
          const value=block.str(way.vals[k]);
          if(value==='roundabout'||value==='circular')roundaboutRaw.push({way:way.id,refs:way.refs});
        }
      }
      const needed = neededWays.has(way.id);
      const laneIndexes = LANE_KEYS.map((k) => block.find(k));
      const hasLaneKey = laneIndexes.some((i) => i >= 0);
      if (!needed && !hasLaneKey) return;
      if (needed) wayRefs.set(way.id, way.refs);
      if (!hasLaneKey) return;

      const highwayKey = block.find("highway");
      const onewayKey = block.find("oneway");
      const tags = {};
      let highway = false;
      let oneway = "";
      for (let k = 0; k < way.keys.length; k++) {
        const key = way.keys[k];
        const at = laneIndexes.indexOf(key);
        if (at >= 0) tags[LANE_KEYS[at]] = block.str(way.vals[k]);
        else if (key === highwayKey) highway = true;
        else if (key === onewayKey) oneway = block.str(way.vals[k]);
      }
      if (highway && Object.keys(tags).length > 0) {
        stats.laneWaysFound++;
        laneRaw.push({ tags, oneway, refs: way.refs });
      }
    },
  });

  // Work out which nodes are needed: next to the via node on restriction ways, and every node of lane ways.
  const trimmed = [];
  for (const r of relations) {
    const fromRefs = wayRefs.has(r.fromWay) ? around(wayRefs.get(r.fromWay), r.viaNode) : null;
    const toRefs = wayRefs.has(r.toWay) ? around(wayRefs.get(r.toWay), r.viaNode) : null;
    if (!fromRefs || !toRefs) {
      stats.restrictionsMissingGeometry++;
      continue;
    }
    trimmed.push({ kind: r.kind, viaNode: r.viaNode, fromRefs, toRefs });
    for (const id of fromRefs) neededNodes.add(id);
    for (const id of toRefs) neededNodes.add(id);
  }
  for (const w of laneRaw) for (const id of w.refs) neededNodes.add(id);
  for (const id of constructionNodes) neededNodes.add(id);
  for (const w of speedRaw) for (const id of w.refs) neededNodes.add(id);
  for (const w of roundaboutRaw) for (const id of w.refs) neededNodes.add(id);

  // Pass 3: node coordinates.
  const coords = new Map();
  const warnings = [];
  await readPbf(path, {
    wantNodeTags: true,
    onNode(id, lat, lon, tags, block) {
      if (neededNodes.has(id)) coords.set(id, [lat, lon]);
      if (!tags) return;
      // Speed cameras (highway=speed_camera) and level crossings (railway=level_crossing).
      const highwayKey = block.find("highway");
      const railwayKey = block.find("railway");
      for (const [k, v] of tags) {
        let kind = 0;
        if (k === highwayKey && v === block.find("speed_camera")) kind = WARNING_SPEED_CAMERA;
        else if (k === railwayKey && v === block.find("level_crossing")) kind = WARNING_LEVEL_CROSSING;
        if (!kind) continue;
        if (inBox([lat, lon])) {
          warnings.push({ kind, lat, lon });
          if (kind === WARNING_SPEED_CAMERA) stats.warningsSpeedCamera++;
          else stats.warningsLevelCrossing++;
        }
      }
    },
  });

  // Assemble the records.
  const restrictions = [];
  for (const t of trimmed) {
    const from = t.fromRefs.map((id) => coords.get(id));
    const to = t.toRefs.map((id) => coords.get(id));
    const via = coords.get(t.viaNode);
    if (!via || from.some((p) => !p) || to.some((p) => !p) || from.length < 2 || to.length < 2) {
      stats.restrictionsMissingGeometry++;
      continue;
    }
    if (!inBox(via)) {
      stats.restrictionsOutsideBox++;
      continue;
    }
    restrictions.push({ kind: t.kind, from, via, to });
  }

  const laneWays = [];
  for (const w of laneRaw) {
    const geom = w.refs.map((id) => coords.get(id));
    if (geom.length < 2 || geom.some((p) => !p)) {
      stats.laneWaysMissingGeometry++;
      continue;
    }
    if (!geom.some(inBox)) {
      stats.laneWaysOutsideBox++;
      continue;
    }
    laneWays.push({ tags: w.tags, oneway: w.oneway, geom });
  }

  const speedWays = [];
  for (const w of speedRaw) {
    const geom = w.refs.map((id) => coords.get(id));
    if (geom.some((p) => !p)) {
      stats.speedWaysMissingGeometry++;
      continue;
    }
    if (!geom.some(inBox)) {
      stats.speedWaysOutsideBox++;
      continue;
    }
    for (const r of w.parsed) speedWays.push({ way: w.way, value: r.value, unit: r.unit, direction: r.direction, oneway: w.oneway, geom });
  }

  const roundaboutWays=[];
  for(const w of roundaboutRaw){
    const geom=w.refs.map(id=>coords.get(id));
    if(geom.length<2||geom.some(p=>!p)){stats.roundaboutWaysMissingGeometry++;continue;}
    if(!geom.some(inBox)){stats.roundaboutWaysOutsideBox++;continue;}
    roundaboutWays.push({way:w.way,geom});
  }
  stats.roundaboutWaysFound=roundaboutWays.length;
  for (const id of constructionNodes) {
    const p = coords.get(id);
    if (p && inBox(p)) {
      warnings.push({ kind: WARNING_ROADWORKS, lat: p[0], lon: p[1] });
      stats.warningsRoadworks++;
    }
  }

  return { restrictions, laneWays, warnings, speedWays, roundaboutWays, stats };
}

async function main() {
  const arg = (n, def) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : def;
  };
  const pbf = arg("pbf");
  if (!pbf) throw new Error("usage: node tools/osm-extract.mjs --pbf=FILE --name=london --bbox=minLon,minLat,maxLon,maxLat");
  const name = arg("name", "london");
  const bbox = arg("bbox", "-0.55,51.28,0.30,51.70").split(",").map(Number);
  const started = Date.now();
  const { restrictions, laneWays, warnings, speedWays, roundaboutWays, stats } = await extractFromPbf(pbf, bbox);

  for (const [dir, data] of [["restrictions", restrictions], ["lanes", laneWays], ["warnings", warnings], ["speed", speedWays],["roundabouts",roundaboutWays]]) {
    const outDir = join(ROOT, "data", "osm-cache", dir);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, `${name}.json`), JSON.stringify(data));
  }
  console.log(JSON.stringify({ name, bbox, restrictions: restrictions.length, laneWays: laneWays.length, warnings: warnings.length, speedWays: speedWays.length, roundaboutWays:roundaboutWays.length, stats }, null, 2));
  console.log(`extracted in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
