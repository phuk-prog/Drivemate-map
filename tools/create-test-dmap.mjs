// Create a simple test DMAP file for QA testing
// Usage: node tools/create-test-dmap.mjs > data/out/test.dmap

import { writeDmap } from './dmap.mjs';

const testMap = {
  bbox: [533400000, -225000000, 533460000, -224700000], // [minLat, minLon, maxLat, maxLon]
  nodes: [
    { lat: 533400000, lon: -225000000 }, // 0
    { lat: 533410000, lon: -224950000 }, // 1
    { lat: 533420000, lon: -224900000 }, // 2
    { lat: 533430000, lon: -224850000 }, // 3
    { lat: 533440000, lon: -224800000 }, // 4
    { lat: 533450000, lon: -224750000 }, // 5
  ],
  edges: [
    // Primary roads
    { from: 0, to: 1, roadClass: 3, flags: 0, points: [[533400000, -225000000], [533410000, -224950000]] },
    { from: 1, to: 2, roadClass: 3, flags: 0, points: [[533410000, -224950000], [533420000, -224900000]] },
    // Secondary roads
    { from: 2, to: 3, roadClass: 4, flags: 0, points: [[533420000, -224900000], [533430000, -224850000]] },
    { from: 3, to: 4, roadClass: 4, flags: 1, points: [[533430000, -224850000], [533440000, -224800000]] }, // one-way
    // Service roads
    { from: 4, to: 5, roadClass: 7, flags: 0, points: [[533440000, -224800000], [533450000, -224750000]] },
    // Return roads
    { from: 5, to: 0, roadClass: 6, flags: 0, points: [[533450000, -224750000], [533400000, -225000000]] },
  ],
  lines: [
    { kind: 4, level: 0, points: [[533400000, -224900000], [533450000, -224900000]] }, // river
    { kind: 1, level: 0, points: [[533410000, -225000000], [533420000, -224950000]] }, // rail
  ],
  polygons: [
    // Water
    {
      kind: 1,
      height: 0,
      minHeight: 0,
      colour: 0,
      rings: [[[533400000, -225000000], [533410000, -225000000], [533410000, -224950000], [533400000, -224950000]]],
    },
    // Building
    {
      kind: 2,
      height: 300, // 30m
      minHeight: 0,
      colour: 0xcccccc,
      rings: [[[533420000, -224900000], [533430000, -224900000], [533430000, -224850000], [533420000, -224850000]]],
    },
    // Park
    {
      kind: 3,
      height: 0,
      minHeight: 0,
      colour: 0x90ee90,
      rings: [[[533440000, -224800000], [533450000, -224800000], [533450000, -224750000], [533440000, -224750000]]],
    },
  ],
  labels: [
    { kind: 1, category: 2, lat: 533410000, lon: -224950000, name: 'Manchester' },
    { kind: 2, category: 3, lat: 533415000, lon: -224925000, name: 'Market Street' },
    { kind: 2, category: 4, lat: 533425000, lon: -224875000, name: 'Secondary Road' },
    { kind: 3, category: 0, lat: 533405000, lon: -224925000, name: 'River Irwell' },
    { kind: 4, category: 0, lat: 533445000, lon: -224775000, name: 'Central Park' },
    { kind: 5, category: 1, lat: 533425000, lon: -224825000, name: 'Restaurant ABC' },
  ],
  restrictions: [
    { kind: 1, from: 0, to: 2, via: 1 }, // no-turn
    { kind: 2, from: 2, to: 4, via: 3 }, // only-turn
  ],
  lanes: [
    { edge: 0, text: 'through|through' },
    { edge: 1, text: 'left|through' },
    { edge: 2, text: 'through|right' },
  ],
  warnings: [
    { kind: 1, lat: 533410000, lon: -224950000 }, // speed camera
    { kind: 2, lat: 533420000, lon: -224900000 }, // level crossing
  ],
  speedLimits: [
    { edge: 0, value: 50, unit: 0 }, // 50 km/h
    { edge: 1, value: 30, unit: 0 }, // 30 km/h
    { edge: 2, value: 40, unit: 0 }, // 40 km/h
    { edge: 3, value: 30, unit: 0 }, // 30 km/h
  ],
  roadNames: [
    { edge: 0, name: 'Main Street' },
    { edge: 1, name: 'Market Street' },
    { edge: 2, name: 'Secondary Avenue' },
  ],
};

const dmap = writeDmap(testMap);
process.stdout.write(dmap);
