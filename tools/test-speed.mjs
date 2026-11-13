// Tests the speed limit parser, the matcher and the DMAP round trip. Needs no download.
// Usage: node tools/test-speed.mjs

import { parseMaxspeed, parseOneway, matchSpeedLimits, SPEED_KMH, SPEED_MPH } from "./speed.mjs";
import { writeDmap, readDmap } from "./dmap.mjs";

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL ${name} ${detail}`);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1. Parser vocabulary.
{
  check("50 is km/h", same(parseMaxspeed("50"), { value: 50, unit: SPEED_KMH }));
  check("30 mph", same(parseMaxspeed("30 mph"), { value: 30, unit: SPEED_MPH }));
  check("30mph and upper case", same(parseMaxspeed("30mph"), { value: 30, unit: 1 }) && same(parseMaxspeed("30 MPH"), { value: 30, unit: 1 }));
  check("50 km/h", same(parseMaxspeed("50 km/h"), { value: 50, unit: 0 }));
  for (const junk of ["national", "signals", "none", "walk", "variable", "GB:nsl_single", "DE:urban", "30;50", "30 knots", "", "abc", "0", "3", "300", "32.5", "-1", "50 mph;30", "120 mph", " "]) {
    check(`dropped: "${junk}"`, parseMaxspeed(junk) === null, JSON.stringify(parseMaxspeed(junk)));
  }
  check("not a string", parseMaxspeed(undefined) === null && parseMaxspeed(50) === null);
  check("oneway values", parseOneway("yes") === 1 && parseOneway("-1") === -1 && parseOneway("no") === 0 && parseOneway("") === 0);
}

// 2. Matching. Coordinates are 1e-7 degree units; 100 units is about 1 m.
const edge = (pts) => ({ from: 0, to: 1, roadClass: 3, flags: 0, points: pts });
const east = edge([[0, -10000], [0, 0], [0, 10000]]); // runs along the way, west to east
const west = edge([[0, 10000], [0, 0], [0, -10000]]); // runs against the way
const way = (extra) => ({ way: 1, value: 50, unit: 0, direction: "both", oneway: 0, geom: [[0, -10000], [0, 10000]], ...extra });
{
  let r = matchSpeedLimits([east], [way()]);
  check("plain limit is matched", same(r.speedLimits, [{ edge: 0, value: 50, unit: 0 }]) && r.stats.matched === 1 && r.stats.matchedKmh === 1, JSON.stringify(r));
  r = matchSpeedLimits([east, west], [way({ unit: 1, value: 30 })]);
  check("plain limit applies to both directions, mph kept", r.speedLimits.length === 2 && r.speedLimits.every((s) => s.value === 30 && s.unit === 1) && r.stats.matchedMph === 2, JSON.stringify(r));
  const fwd = way({ direction: "forward", value: 40 });
  const back = way({ direction: "backward", value: 30 });
  r = matchSpeedLimits([east, west], [fwd, back]);
  check("forward and backward are chosen by direction", same(r.speedLimits, [{ edge: 0, value: 40, unit: 0 }, { edge: 1, value: 30, unit: 0 }]), JSON.stringify(r));
  r = matchSpeedLimits([east, west], [way({ value: 50 }), fwd]);
  check("forward overrides plain along the way, plain applies against it", same(r.speedLimits, [{ edge: 0, value: 40, unit: 0 }, { edge: 1, value: 50, unit: 0 }]), JSON.stringify(r));
  r = matchSpeedLimits([west], [fwd]);
  check("only a forward limit: the opposite direction gets nothing", r.speedLimits.length === 0 && r.stats.noTagForDirection === 1, JSON.stringify(r.stats));
  r = matchSpeedLimits([west], [way({ oneway: 1 })]);
  check("edge against a oneway way gets nothing", r.speedLimits.length === 0 && r.stats.oneWayAgainstWay === 1, JSON.stringify(r.stats));
  r = matchSpeedLimits([east, west], [way({ oneway: -1 })]);
  check("oneway=-1 gives the limit to the edge that runs against the way geometry", same(r.speedLimits, [{ edge: 1, value: 50, unit: 0 }]), JSON.stringify(r));
  const far = way({ geom: [[2000, -10000], [2000, 10000]] });
  r = matchSpeedLimits([east], [far]);
  check("a road 20 m away does not match", r.speedLimits.length === 0 && r.stats.noWay === 1, JSON.stringify(r.stats));
  const cross = way({ geom: [[-10000, 0], [10000, 0]] });
  r = matchSpeedLimits([east], [cross]);
  check("a crossing road does not match (direction)", r.speedLimits.length === 0, JSON.stringify(r.stats));
  r = matchSpeedLimits([east], [way({ way: 1, value: 30 }), way({ way: 2, value: 50, geom: [[100, -10000], [100, 10000]] })]);
  check("two close ways with different limits: unmatched, not guessed", r.speedLimits.length === 0 && r.stats.ambiguous === 1, JSON.stringify(r));
  r = matchSpeedLimits([east], [way({ way: 1, value: 30 }), way({ way: 2, value: 30, geom: [[100, -10000], [100, 10000]] })]);
  check("a close way with the same limit is fine", same(r.speedLimits, [{ edge: 0, value: 30, unit: 0 }]), JSON.stringify(r));
  r = matchSpeedLimits([east], [way({ value: 30 }), way({ way: 2, value: 50, geom: [[600, -10000], [600, 10000]] })]);
  check("a clearly nearer way wins", same(r.speedLimits, [{ edge: 0, value: 30, unit: 0 }]), JSON.stringify(r));
  r = matchSpeedLimits([east], []);
  check("no speed ways: nothing, no error", r.speedLimits.length === 0 && r.stats.noWay === 1);
}

// 3. DMAP round trip and old versions.
{
  const nodes = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10000 }];
  const edges = [{ from: 0, to: 1, roadClass: 3, flags: 0, points: [[0, 0], [0, 10000]] }];
  const speedLimits = [{ edge: 0, value: 30, unit: 1 }, { edge: 0, value: 120, unit: 0 }];
  const base = { bbox: [0, 0, 0, 0], nodes, edges, lines: [], polygons: [], labels: [] };
  const bytes = writeDmap({ ...base, speedLimits });
  check("file is version 7", bytes.readUInt16LE(4) === 7);
  check("round trip keeps speed limits", same(readDmap(bytes).speedLimits, speedLimits), JSON.stringify(readDmap(bytes).speedLimits));
  const v6 = Buffer.from(bytes.subarray(0, bytes.length - (4 + speedLimits.length * 6)));
  v6.writeUInt16LE(6, 4);
  const r6 = readDmap(v6);
  check("version 6 file reads, with no speed limits", r6.speedLimits.length === 0 && r6.edges.length === 1);
  const empty = writeDmap(base);
  check("no speed limits writes an empty section", readDmap(empty).speedLimits.length === 0 && empty.length === bytes.length - speedLimits.length * 6);
  const v3 = Buffer.from(empty.subarray(0, empty.length - 16));
  v3.writeUInt16LE(3, 4);
  check("version 3 file reads", readDmap(v3).speedLimits.length === 0 && readDmap(v3).restrictions.length === 0);
  const bad = Buffer.from(bytes);
  bad.writeUInt16LE(8, 4);
  let threw = false;
  try { readDmap(bad); } catch { threw = true; }
  check("version 8 is refused", threw);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall speed checks passed");
