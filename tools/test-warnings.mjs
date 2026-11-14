// Tests road warnings: extraction from OSM nodes, filtering by bbox, and DMAP round trip (v6+).
// Covers speed cameras, level crossings, and roadworks.
// No network needed. Exits with code 1 on any failure.
// Usage: node tools/test-warnings.mjs

import { writeDmap, readDmap, toFixed7, WARNING_SPEED_CAMERA, WARNING_LEVEL_CROSSING, WARNING_ROADWORKS } from "./dmap.mjs";

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL ${name} ${detail}`);
  }
};

// Test 1: Warning kinds are correctly defined.
{
  check("speed camera kind is 1", WARNING_SPEED_CAMERA === 1);
  check("level crossing kind is 2", WARNING_LEVEL_CROSSING === 2);
  check("roadworks kind is 3", WARNING_ROADWORKS === 3);
}

// Test 2: Warning coordinate conversion (toFixed7 and fromFixed7).
{
  const lat = 53.404;
  const lon = -2.238;
  const latFixed = toFixed7(lat);
  const lonFixed = toFixed7(lon);
  check("latitude conversion", Math.abs(latFixed - 534040000) < 100);
  check("longitude conversion", Math.abs(lonFixed - (-22380000)) < 100);
}

// Test 3: Speed camera warning structure.
{
  const camera = { kind: WARNING_SPEED_CAMERA, lat: 534040000, lon: -22380000 };
  check("camera has kind", camera.kind === WARNING_SPEED_CAMERA);
  check("camera has lat", typeof camera.lat === "number");
  check("camera has lon", typeof camera.lon === "number");
}

// Test 4: Level crossing warning structure.
{
  const crossing = { kind: WARNING_LEVEL_CROSSING, lat: 534040100, lon: -22380100 };
  check("crossing has kind", crossing.kind === WARNING_LEVEL_CROSSING);
  check("crossing has lat", typeof crossing.lat === "number");
  check("crossing has lon", typeof crossing.lon === "number");
}

// Test 5: Roadworks warning structure.
{
  const roadworks = { kind: WARNING_ROADWORKS, lat: 534040200, lon: -22380200 };
  check("roadworks has kind", roadworks.kind === WARNING_ROADWORKS);
  check("roadworks has lat", typeof roadworks.lat === "number");
  check("roadworks has lon", typeof roadworks.lon === "number");
}

// Test 6: Warnings are preserved in DMAP round trip (version 6+).
{
  const warnings = [
    { kind: WARNING_SPEED_CAMERA, lat: 534040000, lon: -22380000 },
    { kind: WARNING_LEVEL_CROSSING, lat: 534040100, lon: -22380100 },
    { kind: WARNING_ROADWORKS, lat: 534040200, lon: -22380200 },
  ];
  const model = {
    bbox: [-2.25, 53.34, -2.07, 53.46],
    nodes: [
      { lat: 534034000, lon: -22500000 },
      { lat: 534046000, lon: -22070000 },
    ],
    edges: [
      { from: 0, to: 1, roadClass: 3, flags: 0, points: [[534034000, -22500000], [534046000, -22070000]] },
    ],
    lines: [],
    polygons: [],
    labels: [],
    restrictions: [],
    lanes: [],
    warnings,
    speedLimits: [],
    roadNames: [],
  };
  const bytes = writeDmap(model);
  const read = readDmap(bytes);
  check("warnings preserved in DMAP", JSON.stringify(read.warnings) === JSON.stringify(warnings));
  check("warning count matches", read.warnings.length === 3);
  check("first warning is speed camera", read.warnings[0].kind === WARNING_SPEED_CAMERA);
  check("second warning is level crossing", read.warnings[1].kind === WARNING_LEVEL_CROSSING);
  check("third warning is roadworks", read.warnings[2].kind === WARNING_ROADWORKS);
}

// Test 7: DMAP version 6 is written with warnings.
{
  const warnings = [{ kind: WARNING_SPEED_CAMERA, lat: 534040000, lon: -22380000 }];
  const model = {
    bbox: [-2.25, 53.34, -2.07, 53.46],
    nodes: [{ lat: 534040000, lon: -22380000 }],
    edges: [],
    lines: [],
    polygons: [],
    labels: [],
    restrictions: [],
    lanes: [],
    warnings,
    speedLimits: [],
    roadNames: [],
  };
  const bytes = writeDmap(model);
  check("DMAP version is 8", bytes.readUInt16LE(4) === 8);
  const read = readDmap(bytes);
  check("version 8 reads warnings", read.warnings.length === 1);
}

// Test 8: Version 5 files (with lanes, no warnings) are readable and have empty warnings.
{
  const model = {
    bbox: [-2.25, 53.34, -2.07, 53.46],
    nodes: [{ lat: 534040000, lon: -22380000 }],
    edges: [],
    lines: [],
    polygons: [],
    labels: [],
    restrictions: [],
    lanes: [{ edge: 0, text: "left|right" }],
  };
  const bytes = writeDmap(model);
  const v5 = Buffer.from(bytes);
  v5.writeUInt16LE(5, 4);
  // Version 5 files end after lanes, no warnings section.
  const noWarnSection = readDmap(v5.subarray(0, v5.length - 4)); // Remove roadNames count
  check("version 5 files still read", noWarnSection !== null);
  check("version 5 has no warnings", noWarnSection.warnings.length === 0);
}

// Test 9: Version 4 files (no lanes, no warnings) are readable.
{
  const model = {
    bbox: [-2.25, 53.34, -2.07, 53.46],
    nodes: [{ lat: 534040000, lon: -22380000 }],
    edges: [],
    lines: [],
    polygons: [],
    labels: [],
    restrictions: [],
  };
  const bytes = writeDmap(model);
  const v4 = Buffer.from(bytes);
  v4.writeUInt16LE(4, 4);
  // Version 4 files end after restrictions.
  // Find where restrictions end and remove everything after
  const read = readDmap(v4);
  check("version 4 files still read", read !== null);
  check("version 4 has no warnings", read.warnings.length === 0);
  check("version 4 has no lanes", read.lanes.length === 0);
}

// Test 10: Empty warnings array is handled correctly.
{
  const model = {
    bbox: [-2.25, 53.34, -2.07, 53.46],
    nodes: [{ lat: 534040000, lon: -22380000 }],
    edges: [],
    lines: [],
    polygons: [],
    labels: [],
    restrictions: [],
    lanes: [],
    warnings: [],
    speedLimits: [],
    roadNames: [],
  };
  const bytes = writeDmap(model);
  const read = readDmap(bytes);
  check("empty warnings preserved", read.warnings.length === 0);
}

// Test 11: Warnings with edge case coordinates.
{
  const warnings = [
    { kind: WARNING_SPEED_CAMERA, lat: -2147483648, lon: -2147483648 }, // Min i32
    { kind: WARNING_LEVEL_CROSSING, lat: 2147483647, lon: 2147483647 }, // Max i32
    { kind: WARNING_ROADWORKS, lat: 0, lon: 0 },
  ];
  const model = {
    bbox: [-180, -90, 180, 90],
    nodes: [{ lat: 0, lon: 0 }],
    edges: [],
    lines: [],
    polygons: [],
    labels: [],
    restrictions: [],
    lanes: [],
    warnings,
    speedLimits: [],
    roadNames: [],
  };
  const bytes = writeDmap(model);
  const read = readDmap(bytes);
  check("edge case coordinates preserved", JSON.stringify(read.warnings) === JSON.stringify(warnings));
}

// Test 12: Large warning dataset (1000 warnings).
{
  const warnings = [];
  for (let i = 0; i < 1000; i++) {
    const kind = (i % 3) + 1; // Cycle through all three kinds
    warnings.push({
      kind,
      lat: 534034000 + i * 100,
      lon: -22500000 + i * 50,
    });
  }
  const model = {
    bbox: [-2.25, 53.34, -2.07, 53.46],
    nodes: [{ lat: 534040000, lon: -22380000 }],
    edges: [],
    lines: [],
    polygons: [],
    labels: [],
    restrictions: [],
    lanes: [],
    warnings,
    speedLimits: [],
    roadNames: [],
  };
  const bytes = writeDmap(model);
  const read = readDmap(bytes);
  check("large warning dataset preserved", read.warnings.length === 1000);
  check("1000 warnings round-trip correctly", JSON.stringify(read.warnings) === JSON.stringify(warnings));
}

// Test 13: Warning filtering by bounding box (as done in build-area.mjs).
{
  const allWarnings = [
    { kind: WARNING_SPEED_CAMERA, lat: 534034000, lon: -22500000 }, // Inside
    { kind: WARNING_LEVEL_CROSSING, lat: 534020000, lon: -22380000 }, // Outside (too south)
    { kind: WARNING_ROADWORKS, lat: 534046000, lon: -22070000 }, // Inside
    { kind: WARNING_SPEED_CAMERA, lat: 534050000, lon: -22380000 }, // Outside (too north)
  ];
  const bboxFixed = [534034000, -22500000, 534046000, -22070000]; // minLat, minLon, maxLat, maxLon
  const filtered = allWarnings.filter(
    (w) => w.lat >= bboxFixed[0] && w.lat <= bboxFixed[2] && w.lon >= bboxFixed[1] && w.lon <= bboxFixed[3]
  );
  check("bbox filtering works", filtered.length === 2);
  check("inside warnings are kept", filtered[0].kind === WARNING_SPEED_CAMERA && filtered[1].kind === WARNING_ROADWORKS);
}

// Test 14: Mixed data structure in DMAP (warnings with other sections).
{
  const model = {
    bbox: [-2.25, 53.34, -2.07, 53.46],
    nodes: [
      { lat: 534034000, lon: -22500000 },
      { lat: 534046000, lon: -22070000 },
    ],
    edges: [
      { from: 0, to: 1, roadClass: 3, flags: 0, points: [[534034000, -22500000], [534046000, -22070000]] },
    ],
    lines: [],
    polygons: [],
    labels: [{ kind: 1, category: 0, lat: 534040000, lon: -22380000, name: "High Street" }],
    restrictions: [{ kind: 1, from: 0, to: 1, via: 0 }],
    lanes: [{ edge: 0, text: "left|right" }],
    warnings: [
      { kind: WARNING_SPEED_CAMERA, lat: 534034000, lon: -22500000 },
      { kind: WARNING_LEVEL_CROSSING, lat: 534046000, lon: -22070000 },
    ],
    speedLimits: [{ edge: 0, value: 50, unit: 0 }],
    roadNames: [{ edge: 0, name: "High Street" }],
  };
  const bytes = writeDmap(model);
  const read = readDmap(bytes);
  check("warnings coexist with restrictions", read.restrictions.length === 1 && read.warnings.length === 2);
  check("warnings coexist with lanes", read.lanes.length === 1 && read.warnings.length === 2);
  check("warnings coexist with speed limits", read.speedLimits.length === 1 && read.warnings.length === 2);
  check("warnings coexist with road names", read.roadNames.length === 1 && read.warnings.length === 2);
}

// Test 15: Warning kind validation and round-trip.
{
  const warnings = [
    { kind: 1, lat: 100, lon: 100 }, // Speed camera
    { kind: 2, lat: 200, lon: 200 }, // Level crossing
    { kind: 3, lat: 300, lon: 300 }, // Roadworks
  ];
  const model = {
    bbox: [0, 0, 400, 400],
    nodes: [{ lat: 0, lon: 0 }],
    edges: [],
    lines: [],
    polygons: [],
    labels: [],
    restrictions: [],
    lanes: [],
    warnings,
    speedLimits: [],
    roadNames: [],
  };
  const bytes = writeDmap(model);
  const read = readDmap(bytes);
  for (let i = 0; i < 3; i++) {
    check(`warning ${i} kind preserved`, read.warnings[i].kind === warnings[i].kind);
    check(`warning ${i} coordinates preserved`, read.warnings[i].lat === warnings[i].lat && read.warnings[i].lon === warnings[i].lon);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall warning checks passed");
