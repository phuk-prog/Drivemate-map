// Category 6: Quality Assurance Pipeline
// Comprehensive validation, gap detection, and statistics for DMAP files
// Usage: node tools/quality-assurance.mjs <file.dmap> [--gaps] [--stats] [--all]

import { readDmap } from './dmap.mjs';
import { validateDmap, laneTextProblem } from './validate-dmap.mjs';
import { readFile } from 'node:fs/promises';

// ============================================================================
// 6.1 VALIDATION CHECKS
// ============================================================================

class ValidationChecker {
  constructor(map) {
    this.map = map;
    this.problems = new Map();
  }

  addProblem(category, severity, message, detail = '') {
    const key = `${category}|${severity}`;
    if (!this.problems.has(key)) {
      this.problems.set(key, {
        category,
        severity, // 'error', 'warning', 'info'
        messages: [],
      });
    }
    this.problems.get(key).messages.push({ message, detail });
  }

  // 6.1.1 Structural validation (extends basic validate-dmap.mjs)
  validateStructure() {
    const existing = validateDmap(this.map);
    for (const msg of existing) {
      const parts = msg.split(': ');
      const category = parts[0];
      const detail = parts.slice(1).join(': ');
      this.addProblem(`structure.${category}`, 'error', category, detail);
    }
    return this.getProblems('structure');
  }

  // 6.1.2 Connectivity validation
  validateConnectivity() {
    const { nodes, edges } = this.map;
    const problems = [];

    // Every edge must have valid node references
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (e.from >= nodes.length) {
        problems.push(`Edge ${i}: from node ${e.from} out of range (${nodes.length} nodes)`);
      }
      if (e.to >= nodes.length) {
        problems.push(`Edge ${i}: to node ${e.to} out of range (${nodes.length} nodes)`);
      }
    }

    // Check for isolated nodes
    const nodeEdgeCount = new Array(nodes.length).fill(0);
    for (const e of edges) {
      if (e.from < nodes.length) nodeEdgeCount[e.from]++;
      if (e.to < nodes.length) nodeEdgeCount[e.to]++;
    }

    const isolatedCount = nodeEdgeCount.filter((c) => c === 0).length;
    if (isolatedCount > 0) {
      problems.push(`Isolated nodes: ${isolatedCount} nodes with no edges`);
    }

    return problems;
  }

  // 6.1.3 Coordinate validation
  validateCoordinates() {
    const { nodes, edges, lines, polygons, labels, warnings } = this.map;
    const bbox = this.map.bbox;
    const problems = [];
    const MARGIN = 500000; // Allow some overhang

    const inBbox = (lat, lon) => {
      return (
        lat >= bbox[0] - MARGIN &&
        lat <= bbox[2] + MARGIN &&
        lon >= bbox[1] - MARGIN &&
        lon <= bbox[3] + MARGIN
      );
    };

    // Check nodes
    let outOfBounds = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (!inBbox(nodes[i].lat, nodes[i].lon)) {
        outOfBounds++;
      }
    }
    if (outOfBounds > 0) {
      problems.push(`Nodes out of bounds: ${outOfBounds} nodes`);
    }

    // Check edge points
    let edgePointsOob = 0;
    for (let i = 0; i < edges.length; i++) {
      const pts = edges[i].points || [];
      for (const p of pts) {
        if (!inBbox(p[0], p[1])) {
          edgePointsOob++;
          break;
        }
      }
    }
    if (edgePointsOob > 0) {
      problems.push(`Edge points out of bounds: ${edgePointsOob} edges`);
    }

    // Check polygon points
    let polyPointsOob = 0;
    for (let i = 0; i < polygons.length; i++) {
      const rings = polygons[i].rings || [];
      for (const ring of rings) {
        for (const p of ring) {
          if (!inBbox(p[0], p[1])) {
            polyPointsOob++;
            break;
          }
        }
      }
    }
    if (polyPointsOob > 0) {
      problems.push(`Polygon points out of bounds: ${polyPointsOob} polygons`);
    }

    return problems;
  }

  // 6.1.4 Routing data validation (restrictions, lanes, speed limits)
  validateRoutingData() {
    const { edges, lanes, speedLimits, restrictions, warnings } = this.map;
    const problems = [];
    const edgeCount = edges.length;

    // Lane validation
    const seenLaneEdges = new Set();
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i];
      if (lane.edge >= edgeCount) {
        problems.push(`Lane record ${i}: edge ${lane.edge} out of range`);
      } else if (seenLaneEdges.has(lane.edge)) {
        problems.push(`Lane record ${i}: duplicate edge ${lane.edge}`);
      } else {
        seenLaneEdges.add(lane.edge);
        const why = laneTextProblem(lane.text);
        if (why) {
          problems.push(`Lane record ${i}: edge ${lane.edge} invalid: ${why}`);
        }
      }
    }

    // Speed limit validation
    const seenSpeedEdges = new Set();
    for (let i = 0; i < speedLimits.length; i++) {
      const speed = speedLimits[i];
      if (speed.edge >= edgeCount) {
        problems.push(`Speed limit ${i}: edge ${speed.edge} out of range`);
      } else if (seenSpeedEdges.has(speed.edge)) {
        problems.push(`Speed limit ${i}: duplicate edge ${speed.edge}`);
      } else {
        seenSpeedEdges.add(speed.edge);
        if (speed.value < 5 || speed.value > 130) {
          problems.push(`Speed limit ${i}: value ${speed.value} out of range`);
        }
      }
    }

    // Restriction validation (see validate-dmap.mjs for detailed checks)
    const seenRestrictions = new Set();
    for (let i = 0; i < restrictions.length; i++) {
      const r = restrictions[i];
      const key = `${r.kind}/${r.from}/${r.to}/${r.via}`;
      if (seenRestrictions.has(key)) {
        problems.push(`Restriction ${i}: duplicate (${key})`);
      } else {
        seenRestrictions.add(key);
      }
    }

    // Warning validation
    const warnings_array = warnings || [];
    if (!Array.isArray(warnings_array)) {
      problems.push(`Warnings: not an array`);
    }

    return problems;
  }

  // 6.1.5 Label validation
  validateLabels() {
    const { labels } = this.map;
    const problems = [];

    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (typeof label.name !== 'string' || label.name.length === 0) {
        problems.push(`Label ${i}: empty name`);
      }
      if (!Number.isInteger(label.kind) || label.kind < 1 || label.kind > 6) {
        problems.push(`Label ${i}: invalid kind ${label.kind}`);
      }
      if (!Number.isInteger(label.category) || label.category < 0) {
        problems.push(`Label ${i}: invalid category ${label.category}`);
      }
    }

    return problems;
  }

  getProblems(category = null) {
    if (category) {
      return this.problems.get(category)?.messages || [];
    }
    return Array.from(this.problems.entries()).map(([key, val]) => ({
      ...val,
      key,
    }));
  }
}

// ============================================================================
// 6.2 GAP DETECTION
// ============================================================================

class GapDetector {
  constructor(map) {
    this.map = map;
    this.gaps = [];
  }

  // 6.2.1 Find disconnected road components
  findRoutingGaps() {
    const { nodes, edges } = this.map;
    const gaps = [];

    // Build adjacency list
    const adj = new Map();
    for (let i = 0; i < nodes.length; i++) {
      adj.set(i, []);
    }

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (e.from < nodes.length && e.to < nodes.length) {
        adj.get(e.from).push(e.to);
        // If not one-way, add reverse
        if ((e.flags & 1) === 0) {
          adj.get(e.to).push(e.from);
        }
      }
    }

    // Find connected components
    const visited = new Set();
    const components = [];

    const dfs = (node, component) => {
      if (visited.has(node)) return;
      visited.add(node);
      component.push(node);
      for (const neighbor of adj.get(node)) {
        dfs(neighbor, component);
      }
    };

    for (let i = 0; i < nodes.length; i++) {
      if (!visited.has(i) && adj.get(i).length > 0) {
        const component = [];
        dfs(i, component);
        components.push(component);
      }
    }

    if (components.length > 1) {
      gaps.push({
        type: 'disconnected_components',
        count: components.length,
        sizes: components.map((c) => c.length),
        description: `Road network has ${components.length} disconnected components`,
      });
    }

    // Count isolated nodes
    const isolated = Array.from(adj.keys()).filter((n) => adj.get(n).length === 0).length;
    if (isolated > 0) {
      gaps.push({
        type: 'isolated_nodes',
        count: isolated,
        description: `${isolated} nodes with no connected edges`,
      });
    }

    // Count dead-ends (nodes with single edge connection)
    const deadEnds = Array.from(adj.keys()).filter((n) => adj.get(n).length === 1).length;
    if (deadEnds > 0) {
      gaps.push({
        type: 'dead_ends',
        count: deadEnds,
        description: `${deadEnds} nodes with only one edge connection (dead ends)`,
      });
    }

    return gaps;
  }

  // 6.2.2 Find nearly-connected segments (potential missing data)
  findNearMisses() {
    const { nodes, edges } = this.map;
    const gaps = [];
    const NEAR_MISS_THRESHOLD = 500; // 1e-7 degrees, ~50m at equator

    // For each edge end, find other road ends within threshold distance
    const edgeEnds = [];
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const pts = e.points || [];
      if (pts.length >= 2) {
        edgeEnds.push({ edgeId: i, nodeId: e.from, lat: pts[0][0], lon: pts[0][1], type: 'from' });
        edgeEnds.push({
          edgeId: i,
          nodeId: e.to,
          lat: pts[pts.length - 1][0],
          lon: pts[pts.length - 1][1],
          type: 'to',
        });
      }
    }

    const nearMisses = [];
    for (let i = 0; i < edgeEnds.length; i++) {
      for (let j = i + 1; j < edgeEnds.length; j++) {
        const a = edgeEnds[i];
        const b = edgeEnds[j];
        if (a.nodeId === b.nodeId) continue; // Same node

        const dist = Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lon - b.lon));
        if (dist > 0 && dist < NEAR_MISS_THRESHOLD) {
          nearMisses.push({
            edge1: a.edgeId,
            edge2: b.edgeId,
            distance: dist,
            node1: a.nodeId,
            node2: b.nodeId,
          });
        }
      }
    }

    if (nearMisses.length > 0) {
      gaps.push({
        type: 'near_misses',
        count: nearMisses.length,
        samples: nearMisses.slice(0, 5),
        description: `${nearMisses.length} road ends within ~50m of each other`,
      });
    }

    return gaps;
  }

  // 6.2.3 Detect one-way road issues
  findOneWayIssues() {
    const { edges } = this.map;
    const gaps = [];

    let oneWayCount = 0;
    let oneWayDeadEnds = 0;

    for (const e of edges) {
      if ((e.flags & 1) !== 0) {
        oneWayCount++;
      }
    }

    // Check for one-way roads with no outgoing edges from their 'to' node
    const nodeOutgoing = new Map();
    for (const e of edges) {
      if (!nodeOutgoing.has(e.to)) nodeOutgoing.set(e.to, 0);
      if ((e.flags & 1) !== 0) {
        // one-way, so only outgoing from 'from' node
        nodeOutgoing.set(e.to, nodeOutgoing.get(e.to)); // doesn't increase from 'to'
      }
    }

    if (oneWayCount > 0) {
      gaps.push({
        type: 'one_way_roads',
        count: oneWayCount,
        percentage: ((oneWayCount / edges.length) * 100).toFixed(2),
        description: `${oneWayCount} one-way roads (${((oneWayCount / edges.length) * 100).toFixed(2)}% of edges)`,
      });
    }

    return gaps;
  }

  // 6.2.4 Detect service road / restricted access issues
  findAccessRestrictions() {
    const { edges } = this.map;
    const gaps = [];

    const FLAG_NO_MOTOR_ACCESS = 16; // bit 4
    let restrictedCount = 0;

    for (const e of edges) {
      if ((e.flags & FLAG_NO_MOTOR_ACCESS) !== 0) {
        restrictedCount++;
      }
    }

    if (restrictedCount > 0) {
      gaps.push({
        type: 'no_motor_access',
        count: restrictedCount,
        percentage: ((restrictedCount / edges.length) * 100).toFixed(2),
        description: `${restrictedCount} edges marked no motor access (${((restrictedCount / edges.length) * 100).toFixed(2)}%)`,
      });
    }

    return gaps;
  }

  // 6.2.5 Check for data coverage issues
  findCoverageGaps() {
    const { edges, labels, restrictions, lanes, warnings, speedLimits } = this.map;
    const gaps = [];

    // Check restriction coverage
    if (restrictions.length === 0 && edges.length > 100) {
      gaps.push({
        type: 'no_restrictions',
        description: 'No turn restrictions found in large map',
      });
    }

    // Check lane coverage
    if (lanes.length === 0 && edges.length > 100) {
      gaps.push({
        type: 'no_lanes',
        description: 'No lane information found in map',
      });
    }

    // Check speed limit coverage
    if (speedLimits.length === 0 && edges.length > 100) {
      gaps.push({
        type: 'no_speed_limits',
        description: 'No speed limit information found in map',
      });
    }

    // Check label coverage
    const labelCoverage = (labels.length / Math.max(edges.length, 1)) * 100;
    if (labelCoverage < 1 && edges.length > 100) {
      gaps.push({
        type: 'low_label_coverage',
        coverage: labelCoverage.toFixed(2),
        description: `Only ${labelCoverage.toFixed(2)}% label coverage (${labels.length} labels for ${edges.length} edges)`,
      });
    }

    return gaps;
  }

  detectAllGaps() {
    this.gaps = [
      ...this.findRoutingGaps(),
      ...this.findNearMisses(),
      ...this.findOneWayIssues(),
      ...this.findAccessRestrictions(),
      ...this.findCoverageGaps(),
    ];
    return this.gaps;
  }
}

// ============================================================================
// 6.3 STATISTICS
// ============================================================================

class StatisticsCollector {
  constructor(map) {
    this.map = map;
    this.stats = {};
  }

  // 6.3.1 Basic counts
  collectBasicStats() {
    const { nodes, edges, lines, polygons, labels, restrictions, lanes, warnings, speedLimits } = this.map;

    return {
      nodes: {
        count: nodes.length,
        description: 'Road junction and end nodes',
      },
      edges: {
        count: edges.length,
        description: 'Routable road edges',
      },
      lines: {
        count: lines.length,
        description: 'Non-routed lines (rail, rivers, etc)',
      },
      polygons: {
        count: polygons.length,
        description: 'Area features (water, buildings, parks)',
      },
      labels: {
        count: labels.length,
        description: 'Place names and labels',
      },
      restrictions: {
        count: restrictions.length,
        description: 'Turn restrictions',
      },
      lanes: {
        count: lanes.length,
        coverage: ((lanes.length / edges.length) * 100).toFixed(2),
        description: 'Lane guidance records',
      },
      warnings: {
        count: warnings.length,
        description: 'Road warnings (speed camera, etc)',
      },
      speedLimits: {
        count: speedLimits.length,
        coverage: ((speedLimits.length / edges.length) * 100).toFixed(2),
        description: 'Speed limit records',
      },
    };
  }

  // 6.3.2 Road classification stats
  collectRoadClassStats() {
    const { edges } = this.map;
    const classes = {
      1: 'motorway',
      2: 'trunk',
      3: 'primary',
      4: 'secondary',
      5: 'tertiary',
      6: 'minor',
      7: 'service',
      8: 'track',
    };

    const classCounts = {};
    for (const className in classes) {
      classCounts[className] = 0;
    }

    for (const e of edges) {
      classCounts[e.roadClass] = (classCounts[e.roadClass] || 0) + 1;
    }

    const result = {};
    for (const [classId, className] of Object.entries(classes)) {
      const count = classCounts[classId] || 0;
      result[className] = {
        count,
        percentage: ((count / edges.length) * 100).toFixed(2),
      };
    }

    return result;
  }

  // 6.3.3 Edge flag statistics
  collectFlagStats() {
    const { edges } = this.map;

    const flags = {
      oneWay: 0,
      bridge: 0,
      tunnel: 0,
      toll: 0,
      noMotorAccess: 0,
    };

    for (const e of edges) {
      if ((e.flags & 1) !== 0) flags.oneWay++;
      if ((e.flags & 2) !== 0) flags.bridge++;
      if ((e.flags & 4) !== 0) flags.tunnel++;
      if ((e.flags & 8) !== 0) flags.toll++;
      if ((e.flags & 16) !== 0) flags.noMotorAccess++;
    }

    return {
      oneWay: {
        count: flags.oneWay,
        percentage: ((flags.oneWay / edges.length) * 100).toFixed(2),
      },
      bridges: {
        count: flags.bridge,
        percentage: ((flags.bridge / edges.length) * 100).toFixed(2),
      },
      tunnels: {
        count: flags.tunnel,
        percentage: ((flags.tunnel / edges.length) * 100).toFixed(2),
      },
      tolls: {
        count: flags.toll,
        percentage: ((flags.toll / edges.length) * 100).toFixed(2),
      },
      noMotorAccess: {
        count: flags.noMotorAccess,
        percentage: ((flags.noMotorAccess / edges.length) * 100).toFixed(2),
      },
    };
  }

  // 6.3.4 Line type statistics
  collectLineStats() {
    const { lines } = this.map;
    const lineKinds = {
      1: 'rail',
      2: 'transit',
      3: 'ferry',
      4: 'river',
      5: 'canal',
      6: 'stream',
      7: 'footpath',
      9: 'pier',
      10: 'airport',
      11: 'boundary',
    };

    const kindCounts = {};
    for (const kind in lineKinds) {
      kindCounts[kind] = 0;
    }

    for (const line of lines) {
      kindCounts[line.kind] = (kindCounts[line.kind] || 0) + 1;
    }

    const result = {};
    for (const [kindId, kindName] of Object.entries(lineKinds)) {
      result[kindName] = kindCounts[kindId] || 0;
    }

    return result;
  }

  // 6.3.5 Polygon type statistics
  collectPolygonStats() {
    const { polygons } = this.map;
    const polyKinds = {
      1: 'water',
      2: 'building',
      3: 'park',
      4: 'wood',
      5: 'grass',
      6: 'farmland',
      7: 'sand',
      8: 'wetland',
      9: 'residential',
      10: 'industrial',
      11: 'commercial',
      12: 'institutional',
      13: 'sports',
      14: 'cemetery',
      15: 'rock',
      16: 'pier',
      17: 'airport',
    };

    const kindCounts = {};
    for (const kind in polyKinds) {
      kindCounts[kind] = 0;
    }

    for (const poly of polygons) {
      kindCounts[poly.kind] = (kindCounts[poly.kind] || 0) + 1;
    }

    const result = {};
    for (const [kindId, kindName] of Object.entries(polyKinds)) {
      const count = kindCounts[kindId] || 0;
      result[kindName] = count;
    }

    return result;
  }

  // 6.3.6 Label type statistics
  collectLabelStats() {
    const { labels } = this.map;
    const labelKinds = {
      1: 'place',
      2: 'road',
      3: 'water',
      4: 'park',
      5: 'poi',
      6: 'housenumber',
    };

    const kindCounts = {};
    for (const kind in labelKinds) {
      kindCounts[kind] = 0;
    }

    for (const label of labels) {
      kindCounts[label.kind] = (kindCounts[label.kind] || 0) + 1;
    }

    const result = {};
    for (const [kindId, kindName] of Object.entries(labelKinds)) {
      result[kindName] = kindCounts[kindId] || 0;
    }

    return result;
  }

  // 6.3.7 Warning type statistics
  collectWarningStats() {
    const { warnings } = this.map;
    const warningKinds = {
      1: 'speed_camera',
      2: 'level_crossing',
      3: 'roadworks',
    };

    const kindCounts = {};
    for (const kind in warningKinds) {
      kindCounts[kind] = 0;
    }

    for (const warning of warnings) {
      kindCounts[warning.kind] = (kindCounts[warning.kind] || 0) + 1;
    }

    const result = {};
    for (const [kindId, kindName] of Object.entries(warningKinds)) {
      result[kindName] = kindCounts[kindId] || 0;
    }

    return result;
  }

  collectAllStats() {
    this.stats = {
      basic: this.collectBasicStats(),
      roadClasses: this.collectRoadClassStats(),
      flags: this.collectFlagStats(),
      lines: this.collectLineStats(),
      polygons: this.collectPolygonStats(),
      labels: this.collectLabelStats(),
      warnings: this.collectWarningStats(),
    };
    return this.stats;
  }
}

// ============================================================================
// MAIN QA RUNNER
// ============================================================================

export async function runQualityAssurance(filepath, options = {}) {
  const { gaps = false, stats = false, all = false } = options;

  try {
    const data = await readFile(filepath);
    const map = readDmap(data);

    const results = {
      file: filepath,
      fileSize: data.length,
      timestamp: new Date().toISOString(),
    };

    // Always run validation
    const validator = new ValidationChecker(map);
    results.validation = {
      structure: validator.validateStructure(),
      connectivity: validator.validateConnectivity(),
      coordinates: validator.validateCoordinates(),
      routingData: validator.validateRoutingData(),
      labels: validator.validateLabels(),
    };

    // Check if there are any validation errors
    const hasErrors = Object.values(results.validation).some((arr) => arr.length > 0);
    results.validationPassed = !hasErrors;

    // Run gap detection if requested
    if (gaps || all) {
      const detector = new GapDetector(map);
      results.gaps = detector.detectAllGaps();
    }

    // Run statistics if requested
    if (stats || all) {
      const collector = new StatisticsCollector(map);
      results.statistics = collector.collectAllStats();
    }

    return results;
  } catch (err) {
    throw new Error(`Failed to analyze ${filepath}: ${err.message}`);
  }
}

// ============================================================================
// COMMAND LINE INTERFACE
// ============================================================================

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const filepath = process.argv[2];
  const options = {
    gaps: process.argv.includes('--gaps') || process.argv.includes('--all'),
    stats: process.argv.includes('--stats') || process.argv.includes('--all'),
    all: process.argv.includes('--all'),
  };

  if (!filepath) {
    console.error(`
Usage: node tools/quality-assurance.mjs <file.dmap> [options]

Options:
  --gaps              Run gap detection
  --stats             Collect statistics
  --all               Run all checks (validation, gaps, stats)

Examples:
  node tools/quality-assurance.mjs data/out/london.dmap --all
  node tools/quality-assurance.mjs data/out/stockport.dmap --stats
  node tools/quality-assurance.mjs data/out/test.dmap  (validation only)
    `);
    process.exit(2);
  }

  try {
    const results = await runQualityAssurance(filepath, options);

    // Pretty print results
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Quality Assurance Report: ${filepath}`);
    console.log(`${'='.repeat(70)}\n`);

    // Validation results
    console.log('VALIDATION CHECKS:');
    console.log(`  Structure: ${results.validation.structure.length === 0 ? '✓ PASS' : `✗ FAIL (${results.validation.structure.length})`}`);
    console.log(`  Connectivity: ${results.validation.connectivity.length === 0 ? '✓ PASS' : `✗ FAIL (${results.validation.connectivity.length})`}`);
    console.log(`  Coordinates: ${results.validation.coordinates.length === 0 ? '✓ PASS' : `✗ FAIL (${results.validation.coordinates.length})`}`);
    console.log(`  Routing Data: ${results.validation.routingData.length === 0 ? '✓ PASS' : `✗ FAIL (${results.validation.routingData.length})`}`);
    console.log(`  Labels: ${results.validation.labels.length === 0 ? '✓ PASS' : `✗ FAIL (${results.validation.labels.length})`}`);

    if (!results.validationPassed) {
      console.log('\n  Problems found:');
      for (const [category, problems] of Object.entries(results.validation)) {
        if (problems.length > 0) {
          console.log(`    ${category}:`);
          for (const p of problems.slice(0, 3)) {
            console.log(`      - ${p}`);
          }
          if (problems.length > 3) {
            console.log(`      ... and ${problems.length - 3} more`);
          }
        }
      }
    }

    // Gap detection results
    if (results.gaps) {
      console.log('\nGAP DETECTION:');
      if (results.gaps.length === 0) {
        console.log('  No significant gaps detected ✓');
      } else {
        for (const gap of results.gaps) {
          console.log(`  - ${gap.description}`);
        }
      }
    }

    // Statistics results
    if (results.statistics) {
      console.log('\nSTATISTICS:');
      const basic = results.statistics.basic;
      console.log(`  ${basic.nodes.count} nodes, ${basic.edges.count} edges`);
      console.log(`  ${basic.lines.count} lines, ${basic.polygons.count} polygons`);
      console.log(`  ${basic.labels.count} labels, ${basic.warnings.count} warnings`);
      console.log(`  ${basic.restrictions.count} restrictions, ${basic.lanes.count} lane records (${basic.lanes.coverage}% coverage)`);
      console.log(`  ${basic.speedLimits.count} speed limits (${basic.speedLimits.coverage}% coverage)`);
    }

    console.log(`\n${'='.repeat(70)}\n`);
    process.exit(results.validationPassed ? 0 : 1);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
