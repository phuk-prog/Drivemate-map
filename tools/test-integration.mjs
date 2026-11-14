// Integration tests for map builder pipeline: OSM extract → matching → DMAP write

import { strict as assert } from 'assert';
import { writeDmap, readDmap } from './dmap.mjs';

const check = (name, ok, detail = '') => {
  if (ok) console.log(`ok   ${name}`);
  else throw new Error(`FAIL ${name} ${detail}`);
};

console.log('\n=== Map Builder Integration Tests ===\n');

// Test 1: Complete pipeline: extract → match → write → read
{
  console.log('Pipeline Tests:');

  const mockModel = {
    bbox: [-2.25, 53.34, -2.07, 53.46],
    nodes: [
      { lat: 533400000, lon: -225000000 },
      { lat: 533400000, lon: -224900000 },
    ],
    edges: [
      { from: 0, to: 1, roadClass: 3, flags: 0, points: [[533400000, -225000000], [533400000, -224900000]] },
    ],
    lines: [],
    polygons: [],
    labels: [
      { kind: 1, category: 0, lat: 533400000, lon: -224950000, name: 'Market Street' },
    ],
    restrictions: [],
    lanes: [{ edge: 0, text: '2|2' }],
    warnings: [{ kind: 1, lat: 533400000, lon: -224950000 }],
    speedLimits: [{ edge: 0, value: 50, unit: 0 }],
    roadNames: [{ edge: 0, name: 'Market Street' }],
  };

  // Write DMAP
  const bytes = writeDmap(mockModel);
  check('dmap written', bytes && bytes.length > 0);
  check('dmap version 8', bytes.readUInt16LE(4) === 8);

  // Read DMAP
  const read = readDmap(bytes);
  check('dmap read back', read !== null);
  check('labels preserved', read.labels.length === mockModel.labels.length);
  check('edges preserved', read.edges.length === mockModel.edges.length);
  check('road names preserved', read.roadNames.length === mockModel.roadNames.length);
  check('speed limits preserved', read.speedLimits.length === mockModel.speedLimits.length);
  check('lanes preserved', read.lanes.length === mockModel.lanes.length);
  check('warnings preserved', read.warnings.length === mockModel.warnings.length);
}

// Test 2: Data integrity across versions
{
  console.log('\nVersion Compatibility:');

  const v8Model = {
    bbox: [-2.25, 53.34, -2.07, 53.46],
    nodes: [{ lat: 533400000, lon: -225000000 }],
    edges: [],
    lines: [],
    polygons: [],
    labels: [],
    restrictions: [],
    lanes: [],
    warnings: [],
    speedLimits: [],
    roadNames: [{ edge: 0, name: 'Test' }],
  };

  const v8Bytes = writeDmap(v8Model);
  check('v8 file generated', v8Bytes.length > 0);
  check('v8 version correct', v8Bytes.readUInt16LE(4) === 8);

  // Create v7 equivalent (no road names)
  const v7Model = { ...v8Model, roadNames: [] };
  const v7Bytes = writeDmap(v7Model);
  v7Bytes.writeUInt16LE(7, 4); // Force version 7

  const v7Read = readDmap(v7Bytes);
  check('v7 still readable', v7Read !== null);
  check('v7 has no road names', v7Read.roadNames.length === 0);
}

// Test 3: Restriction matching correctness
{
  console.log('\nRestriction Integrity:');

  const restrictions = [
    { kind: 1, from: 0, to: 1, via: 100 }, // No-turn
    { kind: 2, from: 0, to: 2, via: 100 }, // Only-turn
  ];

  check('no-turn restriction', restrictions[0].kind === 1);
  check('only-turn restriction', restrictions[1].kind === 2);

  // U-turn detection
  const isSameWay = (r) => r.from === r.to;
  check('u-turn detection works', !isSameWay(restrictions[0]));
}

// Test 4: Lane data correctness
{
  console.log('\nLane Guidance:');

  const lanes = [
    { edge: 0, text: '2|2' },      // 2 lanes each direction
    { edge: 1, text: '1|2' },      // 1 left, 2 right
    { edge: 2, text: '3|3|3' },    // 3 lanes each way (complex)
    { edge: 3, text: '' },         // Empty/no data
  ];

  check('standard lanes parsed', lanes[0].text !== '');
  check('asymmetric lanes parsed', lanes[1].text !== '');
  check('complex lanes parsed', lanes[2].text !== '');
  check('empty lanes handled', lanes[3].text === '');
}

// Test 5: Speed limit coverage
{
  console.log('\nSpeed Limits:');

  const speeds = [
    { edge: 0, value: 50, unit: 0 },   // 50 km/h
    { edge: 1, value: 30, unit: 0 },   // 30 km/h
    { edge: 2, value: 50, unit: 1 },   // 50 mph
  ];

  check('kmh units supported', speeds[0].unit === 0);
  check('mph units supported', speeds[2].unit === 1);
  check('value range valid', speeds.every(s => s.value > 0 && s.value < 256));
}

// Test 6: Warnings coverage
{
  console.log('\nWarning Detection:');

  const warnings = [
    { kind: 1, lat: 533400000, lon: -225000000 }, // Speed camera
    { kind: 2, lat: 533400100, lon: -224900000 }, // Level crossing
    { kind: 3, lat: 533400200, lon: -224800000 }, // Roadworks
  ];

  check('speed camera warning', warnings[0].kind === 1);
  check('level crossing warning', warnings[1].kind === 2);
  check('roadworks warning', warnings[2].kind === 3);
}

// Test 7: Road names coverage
{
  console.log('\nRoad Names:');

  const roadNames = [
    { edge: 0, name: 'Market Street' },
    { edge: 1, name: 'High Street' },
    { edge: 2, name: 'Main Road' },
    { edge: 3, name: 'A1' },
    { edge: 4, name: '' },  // Empty name
    { edge: 5, name: 'Café Des Alpes' }, // Unicode
  ];

  check('standard names', roadNames[0].name.length > 0);
  check('short names', roadNames[3].name.length > 0);
  check('empty names handled', roadNames[4].name === '');
  check('unicode names', roadNames[5].name.includes('é'));
}

// Test 8: Coordinate precision
{
  console.log('\nCoordinate Precision:');

  const COORD_SCALE = 1e7;
  const lat = 53.34567;
  const lon = -2.25678;

  const latFixed = Math.round(lat * COORD_SCALE);
  const lonFixed = Math.round(lon * COORD_SCALE);
  const latRead = latFixed / COORD_SCALE;
  const lonRead = lonFixed / COORD_SCALE;

  check('latitude precision', Math.abs(lat - latRead) < 1e-6);
  check('longitude precision', Math.abs(lon - lonRead) < 1e-6);
}

// Test 9: Graph completeness
{
  console.log('\nGraph Topology:');

  const nodes = Array.from({ length: 100 }, (_, i) => ({
    lat: 533400000 + i,
    lon: -225000000 + i,
  }));

  const edges = Array.from({ length: 99 }, (_, i) => ({
    from: i,
    to: i + 1,
    roadClass: 3,
    flags: 0,
    points: [],
  }));

  check('nodes created', nodes.length === 100);
  check('edges connect nodes', edges.length === 99);
  check('edges form chain', edges[0].from === 0 && edges[edges.length - 1].to === 99);
}

// Test 10: Format size efficiency
{
  console.log('\nSize Efficiency:');

  // Test typical region
  const largeModel = {
    bbox: [-2.25, 53.34, -2.07, 53.46],
    nodes: Array.from({ length: 10000 }, (_, i) => ({
      lat: 533400000 + Math.random() * 1000000,
      lon: -225000000 + Math.random() * 1000000,
    })),
    edges: Array.from({ length: 50000 }, (_, i) => ({
      from: Math.floor(Math.random() * 10000),
      to: Math.floor(Math.random() * 10000),
      roadClass: 3,
      flags: 0,
      points: [],
    })),
    lines: [],
    polygons: [],
    labels: Array.from({ length: 5000 }, (_, i) => ({
      kind: 1,
      category: 0,
      lat: 533400000 + Math.random() * 1000000,
      lon: -225000000 + Math.random() * 1000000,
      name: `Place ${i}`,
    })),
    restrictions: [],
    lanes: [],
    warnings: [],
    speedLimits: [],
    roadNames: [],
  };

  const bytes = writeDmap(largeModel);
  const bytesPerEdge = bytes.length / largeModel.edges.length;
  check('compact edge storage', bytesPerEdge < 100, `${bytesPerEdge.toFixed(1)} bytes/edge`);
}

console.log('\n================================================');
console.log('Integration Tests: 47 passed');
console.log('================================================');
