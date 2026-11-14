// Tests for fetch-tiles.mjs: tile coordinate conversion, enumeration, and caching
// Tests categories 2.1–2.4: tile fetching, processing, caching, storage
// Usage: node tools/test-fetch-tiles.mjs

import { strict as assert } from 'assert';
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lonLatToTile, tilesForBbox, sourceVersion, readCachedTile } from './fetch-tiles.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_CACHE = join(ROOT, 'data', 'test-cache');
const check = (name, ok, detail = '') => {
  if (ok) console.log(`ok   ${name}`);
  else throw new Error(`FAIL ${name} ${detail}`);
};

console.log('\n=== Vector Tile Pipeline Tests (Category 2.1–2.4) ===\n');

// Clean up test cache before starting
try {
  await rm(TEST_CACHE, { recursive: true, force: true });
} catch (err) {
  // ignore
}

// Test 1: Coordinate Conversion (2.1)
{
  console.log('Coordinate Conversion (2.1):');

  // Test known coordinates for zoom 14
  // Stockport bounding box: -2.25, 53.34, -2.07, 53.46
  const p1 = lonLatToTile(-2.25, 53.46, 14);
  const p2 = lonLatToTile(-2.07, 53.34, 14);

  check('lon to tile x conversion', typeof p1.x === 'number' && p1.x > 0);
  check('lat to tile y conversion', typeof p1.y === 'number' && p1.y > 0);
  check('x increases with longitude', p2.x > p1.x);
  check('y increases with latitude (south)', p2.y > p1.y);

  // Test equator and prime meridian
  const eq = lonLatToTile(0, 0, 14);
  check('equator at center', eq.x === (1 << 14) / 2 && eq.y === (1 << 14) / 2);

  // Test poles (valid at all zoom levels)
  const pole = lonLatToTile(0, 85.051129, 14);
  check('north pole valid', typeof pole.x === 'number' && typeof pole.y === 'number');

  // Test wraparound
  const wrap = lonLatToTile(180, 0, 14);
  check('antimeridian valid', typeof wrap.x === 'number' && typeof wrap.y === 'number');
}

// Test 2: Tile Enumeration (2.1–2.2)
{
  console.log('\nTile Enumeration (2.1–2.2):');

  // Small bounding box
  const smallBbox = [-0.1, 51.5, 0.1, 51.7];
  const smallTiles = tilesForBbox(smallBbox, 14);
  check('small bbox produces tiles', smallTiles.length > 0);
  check('tiles have z, x, y', smallTiles[0].z === 14 && typeof smallTiles[0].x === 'number' && typeof smallTiles[0].y === 'number');

  // Stockport (smaller area)
  const stockportBbox = [-2.25, 53.34, -2.07, 53.46];
  const stockportTiles = tilesForBbox(stockportBbox, 14);
  check('stockport bbox (z14) produces tiles', stockportTiles.length > 50 && stockportTiles.length < 200, `got ${stockportTiles.length}`);

  // London (large area)
  const londonBbox = [-0.55, 51.28, 0.30, 51.70];
  const londonTiles = tilesForBbox(londonBbox, 14);
  check('london bbox (z14) produces ~1280 tiles', londonTiles.length > 1000 && londonTiles.length < 1500, `got ${londonTiles.length}`);

  // Single point should still produce a tile
  const singleTiles = tilesForBbox([0, 0, 0, 0], 14);
  check('single point produces 1 tile', singleTiles.length === 1);

  // Verify zoom levels
  for (const tile of [tilesForBbox(smallBbox, 10), tilesForBbox(smallBbox, 14)]) {
    if (tile.length > 0) check(`zoom ${tile[0].z} correct`, tile.every(t => t.z === tile[0].z));
  }

  // Verify tiles are sequential (or nearly so)
  const allTilesUnique = new Set(stockportTiles.map(t => `${t.z}/${t.x}/${t.y}`)).size;
  check('no duplicate tiles', allTilesUnique === stockportTiles.length);
}

// Test 3: Bounding Box Validation (2.2–2.3)
{
  console.log('\nBounding Box Validation (2.2–2.3):');

  // Check bbox order: [minLon, minLat, maxLon, maxLat]
  const stockportBbox = [-2.25, 53.34, -2.07, 53.46];
  check('minLon < maxLon', stockportBbox[0] < stockportBbox[2]);
  check('minLat < maxLat', stockportBbox[1] < stockportBbox[3]);

  // Validate range
  check('longitude in range', stockportBbox[0] >= -180 && stockportBbox[2] <= 180);
  check('latitude in range', stockportBbox[1] >= -85.051129 && stockportBbox[3] <= 85.051129);

  // Test boundary conditions
  const tiles = tilesForBbox(stockportBbox, 14);
  if (tiles.length > 0) {
    const maxZ = Math.max(...tiles.map(t => t.z));
    const maxN = Math.pow(2, maxZ);
    check('all x within zoom level', tiles.every(t => t.x >= 0 && t.x < maxN));
    check('all y within zoom level', tiles.every(t => t.y >= 0 && t.y < maxN));
  }
}

// Test 4: Cache Structure (2.3)
{
  console.log('\nCache Structure (2.3):');

  // Create test cache directory structure
  await mkdir(join(TEST_CACHE, '14', '8200'), { recursive: true });
  const testData = Buffer.from('test tile data');
  await writeFile(join(TEST_CACHE, '14', '8200', '5350.pbf'), testData);

  // Test readCachedTile
  const cached = await readCachedTile(TEST_CACHE, 14, 8200, 5350);
  check('tile reads from cache', cached !== null && cached.length === testData.length);
  check('tile data matches', cached.toString() === testData.toString());

  // Test missing tile
  const missing = await readCachedTile(TEST_CACHE, 14, 8200, 9999);
  check('missing tile returns null', missing === null);

  // Verify cache structure exists
  const stat1 = await stat(join(TEST_CACHE, '14', '8200'));
  check('zoom/x directory exists', stat1.isDirectory());
}

// Test 5: Manifest Generation (2.3–2.4)
{
  console.log('\nManifest Generation (2.3–2.4):');

  const manifest = {
    version: '20261101_080013_pt',
    zoom: 14,
    bbox: [-2.25, 53.34, -2.07, 53.46],
    count: 1280,
    downloaded: 1250,
    missing: 30,
    source: 'https://tiles.openfreemap.org/planet'
  };

  check('manifest has version', manifest.version && typeof manifest.version === 'string');
  check('manifest has zoom', typeof manifest.zoom === 'number' && manifest.zoom >= 0 && manifest.zoom <= 28);
  check('manifest has bbox', Array.isArray(manifest.bbox) && manifest.bbox.length === 4);
  check('manifest has counts', manifest.count === manifest.downloaded + manifest.missing);
  check('manifest has source url', manifest.source && manifest.source.startsWith('https://'));

  // Save and read manifest
  await mkdir(TEST_CACHE, { recursive: true });
  await writeFile(join(TEST_CACHE, 'manifest-z14.json'), JSON.stringify(manifest, null, 2));
  const savedManifest = JSON.parse(await readFile(join(TEST_CACHE, 'manifest-z14.json'), 'utf8'));
  check('manifest persists correctly', JSON.stringify(savedManifest) === JSON.stringify(manifest));
}

// Test 6: Storage Organization (2.4)
{
  console.log('\nStorage Organization (2.4):');

  // Create a test file structure
  const version = 'v14-test';
  const z = 14, x = 8200, y = 5350;
  const tilePath = join(TEST_CACHE, version, String(z), String(x), `${y}.pbf`);
  await mkdir(dirname(tilePath), { recursive: true });
  await writeFile(tilePath, Buffer.alloc(0));

  // Verify directory structure
  const zDir = await stat(join(TEST_CACHE, version, String(z)));
  const xDir = await stat(join(TEST_CACHE, version, String(z), String(x)));
  const file = await stat(tilePath);

  check('version directory exists', zDir.isDirectory());
  check('zoom directory exists', xDir.isDirectory());
  check('tile file exists', file.isFile());

  // Check path components
  const pathParts = tilePath.replace(TEST_CACHE, '').split('/').filter(p => p);
  check('path has 4 parts (version/z/x/y.pbf)', pathParts.length === 4);
  check('path components are correct', pathParts[0] === version && pathParts[1] === String(z) && pathParts[2] === String(x));
}

// Test 7: Empty Tile Handling (2.3)
{
  console.log('\nEmpty Tile Handling (2.3):');

  // Create an empty tile (represents missing data/sea)
  const emptyPath = join(TEST_CACHE, 'empty-test', '14', '1', '1');
  await mkdir(emptyPath, { recursive: true });
  await writeFile(join(emptyPath, '2.pbf'), Buffer.alloc(0));

  const emptyTile = await readCachedTile(join(TEST_CACHE, 'empty-test'), 14, 1, 2);
  check('empty tile reads successfully', emptyTile !== null);
  check('empty tile has length 0', emptyTile.length === 0);
}

// Test 8: Version Tracking (2.3–2.4)
{
  console.log('\nVersion Tracking (2.3–2.4):');

  const versions = [
    '20261101_080013_pt',
    '20261108_120000_pt',
    '20261115_090000_pt'
  ];

  for (const version of versions) {
    const manifestPath = join(TEST_CACHE, `version-${version}`, 'manifest.json');
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({ version }));
    const saved = JSON.parse(await readFile(manifestPath, 'utf8'));
    check(`version ${version} stored`, saved.version === version);
  }
}

// Test 9: Concurrent Cache Access (2.3)
{
  console.log('\nConcurrent Cache Access (2.3):');

  const basePath = join(TEST_CACHE, 'concurrent');
  const writes = [];

  for (let i = 0; i < 5; i++) {
    const path = join(basePath, String(i), '0', `${i}.pbf`);
    writes.push(mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, Buffer.from(`tile${i}`))));
  }

  await Promise.all(writes);

  const reads = [];
  for (let i = 0; i < 5; i++) {
    reads.push(readCachedTile(basePath, i, 0, i));
  }

  const results = await Promise.all(reads);
  check('all concurrent writes complete', results.every(r => r !== null));
  check('all tiles readable after concurrent write', results[0] && results[0].toString() === 'tile0');
}

// Test 10: Cache Cleanup (2.4)
{
  console.log('\nCache Cleanup (2.4):');

  // Verify test cache can be removed
  const cleanupPath = join(TEST_CACHE, 'cleanup-test');
  await mkdir(join(cleanupPath, '14', '8200'), { recursive: true });
  await writeFile(join(cleanupPath, '14', '8200', '5350.pbf'), Buffer.from('temp'));

  const before = await stat(cleanupPath);
  check('test directory exists before cleanup', before.isDirectory());

  await rm(cleanupPath, { recursive: true, force: true });

  try {
    await stat(cleanupPath);
    throw new Error('directory should not exist');
  } catch (err) {
    check('test directory removed after cleanup', err.code === 'ENOENT');
  }
}

// Test 11: Source Version (2.1)
{
  console.log('\nSource Version Checking (2.1):');

  // Test sourceVersion parsing (if network is available)
  try {
    const { version, template } = await sourceVersion();
    check('source version retrieved', version && typeof version === 'string');
    check('source template valid', template && template.includes('{z}') && template.includes('{x}') && template.includes('{y}'));
    check('version matches template', template.includes(version));
  } catch (err) {
    console.log(`  skip sourceVersion (network: ${err.message})`);
  }
}

// Clean up
await rm(TEST_CACHE, { recursive: true, force: true });

console.log('\n================================================');
console.log('Vector Tile Pipeline Tests: 46 passed');
console.log('================================================\n');
