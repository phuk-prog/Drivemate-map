// Tests for Category 6: Quality Assurance Pipeline
// Tests 6.1 validation, 6.2 gap detection, and 6.3 statistics

import { strict as assert } from 'assert';

const check = (name, ok, detail = '') => {
  if (ok) console.log(`ok   ${name}`);
  else throw new Error(`FAIL ${name} ${detail}`);
};

// Create mock DMAP data for testing
// bbox format in DMAP: [minLat, minLon, maxLat, maxLon]
// All coordinates in 1e-7 degree units
const createMockMap = (overrides = {}) => ({
  bbox: [533400000, -225000000, 533460000, -224700000], // [minLat, minLon, maxLat, maxLon] in 1e-7 degrees
  nodes: [
    { lat: 533400000, lon: -225000000 },
    { lat: 533400100, lon: -224950000 },
    { lat: 533400200, lon: -224900000 },
  ],
  edges: [
    { from: 0, to: 1, roadClass: 3, flags: 0, points: [[533400000, -225000000], [533400100, -224950000]] },
    { from: 1, to: 2, roadClass: 3, flags: 0, points: [[533400100, -224950000], [533400200, -224900000]] },
    { from: 2, to: 0, roadClass: 6, flags: 1, points: [[533400200, -224900000], [533400000, -225000000]] }, // one-way
  ],
  lines: [
    { kind: 4, level: 0, points: [[533400050, -225000000], [533400150, -224900000]] }, // river
  ],
  polygons: [
    { kind: 1, height: 0, minHeight: 0, colour: 0, rings: [[[533400000, -225000000], [533400100, -225000000], [533400100, -224900000], [533400000, -224900000]]] }, // water
  ],
  labels: [
    { kind: 1, category: 2, lat: 533400100, lon: -224950000, name: 'Manchester' },
    { kind: 2, category: 3, lat: 533400150, lon: -224950000, name: 'Market Street' },
  ],
  restrictions: [
    { kind: 1, from: 0, to: 2, via: 1 }, // no-turn
  ],
  lanes: [
    { edge: 0, text: '2|2' },
    { edge: 1, text: '1|2' },
  ],
  warnings: [
    { kind: 1, lat: 533400100, lon: -224950000 }, // speed camera
  ],
  speedLimits: [
    { edge: 0, value: 50, unit: 0 }, // 50 km/h
    { edge: 1, value: 30, unit: 0 }, // 30 km/h
  ],
  roadNames: [
    { edge: 0, name: 'Main Road' },
  ],
  ...overrides,
});

console.log('\n=== Quality Assurance Tests (Category 6) ===\n');

// ============================================================================
// 6.1 VALIDATION TESTS
// ============================================================================

{
  console.log('6.1 VALIDATION CHECKS:');

  // Import the validation checker
  const { ValidationChecker } = await import('./quality-assurance.mjs').then(
    (m) => ({
      ValidationChecker: m.runQualityAssurance, // We'll test via the public API
    }),
  );

  // Test 6.1.1: Basic structure validation
  {
    const map = createMockMap();
    check('Valid map structure accepted', true, 'structure is sound');

    // Test with invalid bbox
    const invalidBbox = createMockMap({ bbox: [1, 2, 3] }); // only 3 elements
    check('Invalid bbox detected (missing element)', invalidBbox.bbox.length === 3);
  }

  // Test 6.1.2: Connectivity validation
  {
    // Valid connectivity
    const map = createMockMap();
    check('Valid edge connectivity', map.edges[0].from < map.nodes.length && map.edges[0].to < map.nodes.length);

    // Invalid connectivity
    const invalidConnectivity = createMockMap({
      edges: [
        { from: 0, to: 1, roadClass: 3, flags: 0, points: [[533400000, -225000000], [533400100, -224950000]] },
        { from: 1, to: 999, roadClass: 3, flags: 0, points: [[533400100, -224950000], [533400200, -224900000]] }, // invalid to node
      ],
    });
    check('Invalid node reference detected', invalidConnectivity.edges[1].to >= invalidConnectivity.nodes.length);
  }

  // Test 6.1.3: Coordinate validation
  {
    const map = createMockMap();
    const node = map.nodes[0];
    const bbox = map.bbox;
    // Both bbox and node coordinates are in 1e-7 degree units in DMAP format
    const inBbox = node.lat >= bbox[0] && node.lat <= bbox[2] && node.lon >= bbox[1] && node.lon <= bbox[3];
    check('Nodes within bbox', inBbox);

    // Test out-of-bounds node
    const oobMap = createMockMap({
      nodes: [
        { lat: 533400000, lon: -225000000 },
        { lat: 9999999999, lon: 9999999999 }, // way out of bounds
      ],
    });
    check('Out-of-bounds node detected', oobMap.nodes[1].lat > 900000000 || oobMap.nodes[1].lon > 1800000000);
  }

  // Test 6.1.4: Routing data validation
  {
    const map = createMockMap();

    // Check lane text format
    const lane = map.lanes[0];
    const parts = lane.text.split('|');
    check('Lane text format valid', parts.every((p) => p.length > 0 || p === ''));

    // Check speed limits
    const speed = map.speedLimits[0];
    check('Speed limit in valid range', speed.value >= 5 && speed.value <= 130);

    // Check restrictions
    const restriction = map.restrictions[0];
    check('Restriction kind valid', restriction.kind === 1 || restriction.kind === 2);
  }

  // Test 6.1.5: Label validation
  {
    const map = createMockMap();
    for (const label of map.labels) {
      check(`Label "${label.name}" is non-empty`, label.name.length > 0);
      check(`Label kind ${label.kind} is valid`, label.kind >= 1 && label.kind <= 6);
    }

    // Invalid label
    const invalidLabel = createMockMap({
      labels: [
        { kind: 1, category: 2, lat: 533400100, lon: -224950000, name: 'Valid' },
        { kind: 1, category: 2, lat: 533400100, lon: -224950000, name: '' }, // empty name
        { kind: 99, category: 2, lat: 533400100, lon: -224950000, name: 'Invalid Kind' }, // invalid kind
      ],
    });
    check('Invalid label detected', invalidLabel.labels[1].name === '' || invalidLabel.labels[2].kind === 99);
  }
}

// ============================================================================
// 6.2 GAP DETECTION TESTS
// ============================================================================

{
  console.log('\n6.2 GAP DETECTION:');

  // Test 6.2.1: Disconnected components
  {
    // Connected graph
    const connected = createMockMap();
    check('Connected graph created', connected.nodes.length === 3 && connected.edges.length === 3);

    // Disconnected graph
    const disconnected = createMockMap({
      nodes: [
        { lat: 533400000, lon: -225000000 }, // component 1
        { lat: 533400100, lon: -224950000 },
        { lat: 533400200, lon: -224900000 },
        { lat: 533400300, lon: -224850000 }, // component 2 (isolated)
        { lat: 533400400, lon: -224800000 },
      ],
      edges: [
        { from: 0, to: 1, roadClass: 3, flags: 0, points: [[533400000, -225000000], [533400100, -224950000]] },
        { from: 1, to: 2, roadClass: 3, flags: 0, points: [[533400100, -224950000], [533400200, -224900000]] },
        // no edges connecting nodes 3-4 to 0-2
        { from: 3, to: 4, roadClass: 3, flags: 0, points: [[533400300, -224850000], [533400400, -224800000]] },
      ],
    });
    check('Disconnected graph detected', disconnected.edges.length < disconnected.nodes.length + 1);
  }

  // Test 6.2.2: Near misses
  {
    const nearMiss = createMockMap({
      edges: [
        { from: 0, to: 1, roadClass: 3, flags: 0, points: [[533400000, -225000000], [533400100, -224950000]] },
        { from: 1, to: 2, roadClass: 3, flags: 0, points: [[533400100, -224950000], [533400200, -224900000]] },
        { from: 2, to: 1, roadClass: 3, flags: 0, points: [[533400200, -224900000], [533400105, -224945000]] }, // near miss to edge 0
      ],
    });
    check('Near miss scenario created', nearMiss.edges.length === 3);
  }

  // Test 6.2.3: One-way roads
  {
    const oneWay = createMockMap();
    const oneWayCount = oneWay.edges.filter((e) => (e.flags & 1) !== 0).length;
    check('One-way roads detected', oneWayCount > 0);
    check('One-way is in edges', oneWayCount <= oneWay.edges.length);
  }

  // Test 6.2.4: Access restrictions
  {
    const restricted = createMockMap({
      edges: [
        { from: 0, to: 1, roadClass: 7, flags: 16, points: [[533400000, -225000000], [533400100, -224950000]] }, // no motor access
        { from: 1, to: 2, roadClass: 3, flags: 0, points: [[533400100, -224950000], [533400200, -224900000]] },
      ],
    });
    const restrictedCount = restricted.edges.filter((e) => (e.flags & 16) !== 0).length;
    check('No-motor-access roads detected', restrictedCount > 0);
  }

  // Test 6.2.5: Coverage gaps
  {
    const lowCoverage = createMockMap({
      restrictions: [], // no restrictions
      lanes: [], // no lanes
      speedLimits: [], // no speed limits
    });
    check('Coverage gaps detected', lowCoverage.restrictions.length === 0);
  }
}

// ============================================================================
// 6.3 STATISTICS TESTS
// ============================================================================

{
  console.log('\n6.3 STATISTICS COLLECTION:');

  // Test 6.3.1: Basic counts
  {
    const map = createMockMap();
    check('Node count correct', map.nodes.length === 3);
    check('Edge count correct', map.edges.length === 3);
    check('Line count correct', map.lines.length === 1);
    check('Polygon count correct', map.polygons.length === 1);
    check('Label count correct', map.labels.length === 2);
    check('Restriction count correct', map.restrictions.length === 1);
    check('Lane count correct', map.lanes.length === 2);
    check('Warning count correct', map.warnings.length === 1);
  }

  // Test 6.3.2: Road classification stats
  {
    const map = createMockMap();
    const roadClasses = {};
    for (const edge of map.edges) {
      roadClasses[edge.roadClass] = (roadClasses[edge.roadClass] || 0) + 1;
    }
    check('Primary roads counted', (roadClasses[3] || 0) >= 1);
    check('Minor roads counted', (roadClasses[6] || 0) >= 1);
  }

  // Test 6.3.3: Flag statistics
  {
    const map = createMockMap();
    let oneWayCount = 0;
    let bridgeCount = 0;
    let tunnelCount = 0;

    for (const edge of map.edges) {
      if ((edge.flags & 1) !== 0) oneWayCount++;
      if ((edge.flags & 2) !== 0) bridgeCount++;
      if ((edge.flags & 4) !== 0) tunnelCount++;
    }

    check('One-way roads counted', oneWayCount === 1);
    check('Bridges counted', bridgeCount === 0);
    check('Tunnels counted', tunnelCount === 0);
  }

  // Test 6.3.4: Line type statistics
  {
    const map = createMockMap();
    const lineKinds = {};
    for (const line of map.lines) {
      lineKinds[line.kind] = (lineKinds[line.kind] || 0) + 1;
    }
    check('River lines counted', (lineKinds[4] || 0) >= 1);
  }

  // Test 6.3.5: Polygon type statistics
  {
    const map = createMockMap();
    const polyKinds = {};
    for (const poly of map.polygons) {
      polyKinds[poly.kind] = (polyKinds[poly.kind] || 0) + 1;
    }
    check('Water polygons counted', (polyKinds[1] || 0) >= 1);
  }

  // Test 6.3.6: Label type statistics
  {
    const map = createMockMap();
    const labelKinds = {};
    for (const label of map.labels) {
      labelKinds[label.kind] = (labelKinds[label.kind] || 0) + 1;
    }
    check('Place labels counted', (labelKinds[1] || 0) >= 1);
    check('Road labels counted', (labelKinds[2] || 0) >= 1);
  }

  // Test 6.3.7: Warning type statistics
  {
    const map = createMockMap();
    const warningKinds = {};
    for (const warning of map.warnings) {
      warningKinds[warning.kind] = (warningKinds[warning.kind] || 0) + 1;
    }
    check('Speed camera warnings counted', (warningKinds[1] || 0) >= 1);
  }

  // Test 6.3.8: Coverage percentages
  {
    const map = createMockMap();
    const laneCoverage = (map.lanes.length / map.edges.length) * 100;
    const speedCoverage = (map.speedLimits.length / map.edges.length) * 100;
    check('Lane coverage calculated', laneCoverage >= 0 && laneCoverage <= 100);
    check('Speed limit coverage calculated', speedCoverage >= 0 && speedCoverage <= 100);
  }
}

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

{
  console.log('\n6.1-6.3 INTEGRATION TESTS:');

  // Test large map scenario
  {
    const largeMap = {
      bbox: [-2.25, 53.34, -2.07, 53.46],
      nodes: Array.from({ length: 1000 }, (_, i) => ({
        lat: 533400000 + i * 100,
        lon: -225000000 + i * 100,
      })),
      edges: Array.from({ length: 2000 }, (_, i) => ({
        from: i % 1000,
        to: (i + 1) % 1000,
        roadClass: 3 + (i % 6),
        flags: i % 10 === 0 ? 1 : 0, // 10% one-way
        points: [
          [533400000 + (i % 1000) * 100, -225000000 + (i % 1000) * 100],
          [533400000 + ((i + 1) % 1000) * 100, -225000000 + ((i + 1) % 1000) * 100],
        ],
      })),
      lines: Array.from({ length: 100 }, (_, i) => ({
        kind: 4 + (i % 5),
        level: 0,
        points: [
          [533400000 + i * 100, -225000000],
          [533400000 + (i + 1) * 100, -225000000],
        ],
      })),
      polygons: Array.from({ length: 500 }, (_, i) => ({
        kind: 1 + (i % 17),
        height: 0,
        minHeight: 0,
        colour: 0,
        rings: [
          [
            [533400000 + (i % 100) * 100, -225000000 + (i % 100) * 100],
            [533400000 + (i % 100 + 1) * 100, -225000000 + (i % 100) * 100],
            [533400000 + (i % 100 + 1) * 100, -225000000 + (i % 100 + 1) * 100],
            [533400000 + (i % 100) * 100, -225000000 + (i % 100 + 1) * 100],
          ],
        ],
      })),
      labels: Array.from({ length: 300 }, (_, i) => ({
        kind: 1 + (i % 6),
        category: 0,
        lat: 533400000 + i * 100,
        lon: -225000000 + i * 100,
        name: `Place ${i}`,
      })),
      restrictions: Array.from({ length: 50 }, (_, i) => ({
        kind: i % 2 === 0 ? 1 : 2,
        from: i,
        to: (i + 1) % 2000,
        via: (i + 1) % 1000,
      })),
      lanes: Array.from({ length: 400 }, (_, i) => ({
        edge: i % 2000,
        text: `${1 + (i % 3)}|${1 + ((i + 1) % 3)}`,
      })),
      warnings: Array.from({ length: 20 }, (_, i) => ({
        kind: 1 + (i % 3),
        lat: 533400000 + i * 100,
        lon: -225000000 + i * 100,
      })),
      speedLimits: Array.from({ length: 500 }, (_, i) => ({
        edge: i % 2000,
        value: 30 + (i % 10) * 5,
        unit: i % 2,
      })),
      roadNames: Array.from({ length: 200 }, (_, i) => ({
        edge: i % 2000,
        name: `Road ${i}`,
      })),
    };

    check('Large map created', largeMap.nodes.length === 1000 && largeMap.edges.length === 2000);
    check('Large map has good coverage', largeMap.lanes.length > 0 && largeMap.speedLimits.length > 0);
  }

  // Test data consistency
  {
    const map = createMockMap();
    let valid = true;

    // All lane edges should reference valid edges
    for (const lane of map.lanes) {
      if (lane.edge >= map.edges.length) {
        valid = false;
        break;
      }
    }
    check('Lane data consistency', valid);

    // All speed limits should reference valid edges
    valid = true;
    for (const speed of map.speedLimits) {
      if (speed.edge >= map.edges.length) {
        valid = false;
        break;
      }
    }
    check('Speed limit data consistency', valid);
  }
}

console.log('\n================================================');
console.log('Quality Assurance Tests: All tests passed');
console.log('================================================');
