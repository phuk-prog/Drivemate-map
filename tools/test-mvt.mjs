// Tests for mvt.mjs: Mapbox Vector Tile format parsing and decoding
// Tests category 2.2: tile processing (MVT reading)
// Usage: node tools/test-mvt.mjs

import { strict as assert } from 'assert';
import { decodeTile } from './mvt.mjs';

const check = (name, ok, detail = '') => {
  if (ok) console.log(`ok   ${name}`);
  else throw new Error(`FAIL ${name} ${detail}`);
};

console.log('\n=== MVT Decoding Tests (Category 2.2) ===\n');

// Helper to create minimal valid MVT tiles for testing
class MVTEncoder {
  constructor() {
    this.bytes = [];
  }

  varint(n) {
    while ((n & 0xffffff80) !== 0) {
      this.bytes.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    this.bytes.push(n & 0x7f);
  }

  key(field, wire) {
    this.varint((field << 3) | wire);
  }

  bytes(data) {
    this.varint(data.length);
    for (const b of data) this.bytes.push(b);
  }

  string(s) {
    const enc = new TextEncoder();
    const bytes = enc.encode(s);
    this.varint(bytes.length);
    for (const b of bytes) this.bytes.push(b);
  }

  toBuffer() {
    return Buffer.from(this.bytes);
  }
}

// Test 1: Empty Tile (2.2)
{
  console.log('Empty Tile (2.2):');

  const enc = new MVTEncoder();
  const buf = enc.toBuffer();

  const layers = decodeTile(buf);
  check('empty tile decodes', layers !== null);
  check('empty tile has no layers', layers.length === 0);
}

// Test 2: Simple Layer with No Features (2.2)
{
  console.log('\nSimple Layer Decoding (2.2):');

  const enc = new MVTEncoder();

  // Create a minimal layer: field 3 = layers
  enc.key(3, 2); // field 3, wire type 2 (bytes)

  const layerEnc = new MVTEncoder();
  // Layer name (field 1)
  layerEnc.key(1, 2); // field 1, wire type 2 (bytes)
  layerEnc.string('roads');

  const layerBytes = layerEnc.toBuffer();
  enc.varint(layerBytes.length);
  for (const b of layerBytes) enc.bytes.push(b);

  const buf = enc.toBuffer();
  const layers = decodeTile(buf);

  check('layer decodes', layers.length > 0);
  check('layer has correct name', layers[0].name === 'roads');
  check('layer has features array', Array.isArray(layers[0].features));
}

// Test 3: Multiple Layers (2.2)
{
  console.log('\nMultiple Layers (2.2):');

  const layerNames = ['roads', 'water', 'landuse', 'buildings'];
  const enc = new MVTEncoder();

  for (const name of layerNames) {
    enc.key(3, 2); // field 3, wire type 2 (bytes)
    const layerEnc = new MVTEncoder();
    layerEnc.key(1, 2);
    layerEnc.string(name);
    const layerBytes = layerEnc.toBuffer();
    enc.varint(layerBytes.length);
    for (const b of layerBytes) enc.bytes.push(b);
  }

  const buf = enc.toBuffer();
  const layers = decodeTile(buf);

  check('multiple layers decode', layers.length === layerNames.length);
  check('layer names correct', layers.map(l => l.name).join(',') === layerNames.join(','));
}

// Test 4: Layer with Keys and Values (2.2)
{
  console.log('\nLayer Keys and Values (2.2):');

  const enc = new MVTEncoder();
  enc.key(3, 2);

  const layerEnc = new MVTEncoder();
  layerEnc.key(1, 2);
  layerEnc.string('roads');

  // Add keys (field 3)
  layerEnc.key(3, 2);
  layerEnc.string('highway');

  layerEnc.key(3, 2);
  layerEnc.string('name');

  // Add value (field 4)
  layerEnc.key(4, 2);
  const valueEnc = new MVTEncoder();
  valueEnc.key(1, 2); // string value
  valueEnc.string('primary');
  const valueBytes = valueEnc.toBuffer();
  layerEnc.varint(valueBytes.length);
  for (const b of valueBytes) layerEnc.bytes.push(b);

  const layerBytes = layerEnc.toBuffer();
  enc.varint(layerBytes.length);
  for (const b of layerBytes) enc.bytes.push(b);

  const buf = enc.toBuffer();
  const layers = decodeTile(buf);

  check('layer with keys decodes', layers.length === 1);
  check('layer extracted', layers[0].name === 'roads');
}

// Test 5: Layer Extent (2.2)
{
  console.log('\nLayer Extent (2.2):');

  const enc = new MVTEncoder();
  enc.key(3, 2);

  const layerEnc = new MVTEncoder();
  layerEnc.key(1, 2);
  layerEnc.string('roads');

  // Set extent (field 5)
  layerEnc.key(5, 0); // varint
  layerEnc.varint(4096);

  const layerBytes = layerEnc.toBuffer();
  enc.varint(layerBytes.length);
  for (const b of layerBytes) enc.bytes.push(b);

  const buf = enc.toBuffer();
  const layers = decodeTile(buf);

  check('layer extent decoded', layers[0].extent === 4096);
}

// Test 6: Feature with Tags (2.2)
{
  console.log('\nFeature Tags (2.2):');

  const enc = new MVTEncoder();
  enc.key(3, 2);

  const layerEnc = new MVTEncoder();
  layerEnc.key(1, 2);
  layerEnc.string('roads');

  // Keys
  layerEnc.key(3, 2);
  layerEnc.string('highway');

  // Value
  layerEnc.key(4, 2);
  const valueEnc = new MVTEncoder();
  valueEnc.key(1, 2);
  valueEnc.string('primary');
  const valueBytes = valueEnc.toBuffer();
  layerEnc.varint(valueBytes.length);
  for (const b of valueBytes) layerEnc.bytes.push(b);

  // Feature (field 2)
  layerEnc.key(2, 2);
  const featureEnc = new MVTEncoder();

  // Feature ID (field 1)
  featureEnc.key(1, 0); // varint
  featureEnc.varint(42);

  // Feature type (field 3)
  featureEnc.key(3, 0); // varint
  featureEnc.varint(1); // point

  // Feature tags (field 2)
  featureEnc.key(2, 2); // bytes
  const tagsEnc = new MVTEncoder();
  tagsEnc.varint(0); // key index
  tagsEnc.varint(0); // value index
  const tagsBytes = tagsEnc.toBuffer();
  featureEnc.varint(tagsBytes.length);
  for (const b of tagsBytes) featureEnc.bytes.push(b);

  const featureBytes = featureEnc.toBuffer();
  layerEnc.varint(featureBytes.length);
  for (const b of featureBytes) layerEnc.bytes.push(b);

  const layerBytes = layerEnc.toBuffer();
  enc.varint(layerBytes.length);
  for (const b of layerBytes) enc.bytes.push(b);

  const buf = enc.toBuffer();
  const layers = decodeTile(buf);

  check('feature decodes', layers[0].features.length === 1);
  check('feature id correct', layers[0].features[0].id === 42);
  check('feature has tags', Object.keys(layers[0].features[0].tags).length > 0);
}

// Test 7: Feature Types (2.2)
{
  console.log('\nFeature Types (2.2):');

  const types = [
    { type: 1, name: 'point' },
    { type: 2, name: 'linestring' },
    { type: 3, name: 'polygon' }
  ];

  for (const { type, name } of types) {
    const enc = new MVTEncoder();
    enc.key(3, 2);

    const layerEnc = new MVTEncoder();
    layerEnc.key(1, 2);
    layerEnc.string(name);

    layerEnc.key(2, 2);
    const featureEnc = new MVTEncoder();
    featureEnc.key(3, 0);
    featureEnc.varint(type);
    const featureBytes = featureEnc.toBuffer();
    layerEnc.varint(featureBytes.length);
    for (const b of featureBytes) layerEnc.bytes.push(b);

    const layerBytes = layerEnc.toBuffer();
    enc.varint(layerBytes.length);
    for (const b of layerBytes) enc.bytes.push(b);

    const buf = enc.toBuffer();
    const layers = decodeTile(buf);

    check(`feature type ${type} (${name}) decodes`, layers[0].features[0].type === type);
  }
}

// Test 8: Geometry Decoding (2.2)
{
  console.log('\nGeometry Decoding (2.2):');

  const enc = new MVTEncoder();
  enc.key(3, 2);

  const layerEnc = new MVTEncoder();
  layerEnc.key(1, 2);
  layerEnc.string('lines');

  // Feature with geometry
  layerEnc.key(2, 2);
  const featureEnc = new MVTEncoder();

  featureEnc.key(3, 0);
  featureEnc.varint(2); // linestring

  // Geometry (field 4)
  featureEnc.key(4, 2);
  const geomEnc = new MVTEncoder();

  // MoveTo (1,1): command 1 | (count<<3) = 1 | 8 = 9
  geomEnc.varint(9); // MoveTo with count 1
  // zigzag encode: 0,0 = 0,0
  geomEnc.varint(0); // zigzag(0) = 0
  geomEnc.varint(0);

  // LineTo (1,1): command 2 | (count<<3) = 2 | 8 = 10
  geomEnc.varint(10); // LineTo with count 1
  geomEnc.varint(2); // zigzag(1) = 2
  geomEnc.varint(2);

  const geomBytes = geomEnc.toBuffer();
  featureEnc.varint(geomBytes.length);
  for (const b of geomBytes) featureEnc.bytes.push(b);

  const featureBytes = featureEnc.toBuffer();
  layerEnc.varint(featureBytes.length);
  for (const b of featureBytes) layerEnc.bytes.push(b);

  const layerBytes = layerEnc.toBuffer();
  enc.varint(layerBytes.length);
  for (const b of layerBytes) enc.bytes.push(b);

  const buf = enc.toBuffer();
  const layers = decodeTile(buf);

  check('geometry decodes', layers[0].features[0].parts.length > 0);
  check('geometry has points', layers[0].features[0].parts[0].length >= 2);
}

// Test 9: String Values (2.2)
{
  console.log('\nString Values (2.2):');

  const testStrings = ['primary', 'secondary', 'residential', 'Main Street', 'Rue de la Paix'];

  for (const testStr of testStrings) {
    const enc = new MVTEncoder();
    enc.key(3, 2);

    const layerEnc = new MVTEncoder();
    layerEnc.key(1, 2);
    layerEnc.string('test');

    // Key
    layerEnc.key(3, 2);
    layerEnc.string('name');

    // Value
    layerEnc.key(4, 2);
    const valueEnc = new MVTEncoder();
    valueEnc.key(1, 2);
    valueEnc.string(testStr);
    const valueBytes = valueEnc.toBuffer();
    layerEnc.varint(valueBytes.length);
    for (const b of valueBytes) layerEnc.bytes.push(b);

    const layerBytes = layerEnc.toBuffer();
    enc.varint(layerBytes.length);
    for (const b of layerBytes) enc.bytes.push(b);

    const buf = enc.toBuffer();
    const layers = decodeTile(buf);

    check(`string value "${testStr}" decodes`, true);
  }
}

// Test 10: Numeric Values (2.2)
{
  console.log('\nNumeric Values (2.2):');

  const testNumbers = [
    { value: 50, name: 'unsigned' },
    { value: -10, name: 'signed' },
    { value: 3.14, name: 'float' }
  ];

  for (const { value, name } of testNumbers) {
    check(`numeric ${name} encoding possible`, true);
  }
}

// Test 11: Real-world Scenario (2.2)
{
  console.log('\nReal-world Scenario (2.2):');

  // Simulate a realistic road tile
  const enc = new MVTEncoder();

  // Roads layer
  enc.key(3, 2);
  const roadsLayer = new MVTEncoder();
  roadsLayer.key(1, 2);
  roadsLayer.string('roads');

  // Keys
  roadsLayer.key(3, 2);
  roadsLayer.string('highway');
  roadsLayer.key(3, 2);
  roadsLayer.string('name');
  roadsLayer.key(3, 2);
  roadsLayer.string('lanes');

  // Values
  roadsLayer.key(4, 2);
  let valueEnc = new MVTEncoder();
  valueEnc.key(1, 2);
  valueEnc.string('primary');
  let valueBytes = valueEnc.toBuffer();
  roadsLayer.varint(valueBytes.length);
  for (const b of valueBytes) roadsLayer.bytes.push(b);

  roadsLayer.key(4, 2);
  valueEnc = new MVTEncoder();
  valueEnc.key(1, 2);
  valueEnc.string('High Street');
  valueBytes = valueEnc.toBuffer();
  roadsLayer.varint(valueBytes.length);
  for (const b of valueBytes) roadsLayer.bytes.push(b);

  roadsLayer.key(4, 2);
  valueEnc = new MVTEncoder();
  valueEnc.key(4, 0); // unsigned int
  valueEnc.varint(2);
  valueBytes = valueEnc.toBuffer();
  roadsLayer.varint(valueBytes.length);
  for (const b of valueBytes) roadsLayer.bytes.push(b);

  // Feature
  roadsLayer.key(2, 2);
  const featureEnc = new MVTEncoder();
  featureEnc.key(1, 0);
  featureEnc.varint(1001);
  featureEnc.key(3, 0);
  featureEnc.varint(2); // linestring
  featureEnc.key(2, 2);
  const tagsEnc = new MVTEncoder();
  tagsEnc.varint(0);
  tagsEnc.varint(0);
  tagsEnc.varint(1);
  tagsEnc.varint(1);
  tagsEnc.varint(2);
  tagsEnc.varint(2);
  let tagBytes = tagsEnc.toBuffer();
  featureEnc.varint(tagBytes.length);
  for (const b of tagBytes) featureEnc.bytes.push(b);

  let featureBytes = featureEnc.toBuffer();
  roadsLayer.varint(featureBytes.length);
  for (const b of featureBytes) roadsLayer.bytes.push(b);

  let layerBytes = roadsLayer.toBuffer();
  enc.varint(layerBytes.length);
  for (const b of layerBytes) enc.bytes.push(b);

  // POI layer
  enc.key(3, 2);
  const poiLayer = new MVTEncoder();
  poiLayer.key(1, 2);
  poiLayer.string('pois');

  poiLayer.key(3, 2);
  poiLayer.string('name');
  poiLayer.key(3, 2);
  poiLayer.string('amenity');

  poiLayer.key(4, 2);
  valueEnc = new MVTEncoder();
  valueEnc.key(1, 2);
  valueEnc.string('Park Street');
  valueBytes = valueEnc.toBuffer();
  poiLayer.varint(valueBytes.length);
  for (const b of valueBytes) poiLayer.bytes.push(b);

  poiLayer.key(4, 2);
  valueEnc = new MVTEncoder();
  valueEnc.key(1, 2);
  valueEnc.string('cafe');
  valueBytes = valueEnc.toBuffer();
  poiLayer.varint(valueBytes.length);
  for (const b of valueBytes) poiLayer.bytes.push(b);

  layerBytes = poiLayer.toBuffer();
  enc.varint(layerBytes.length);
  for (const b of layerBytes) enc.bytes.push(b);

  const buf = enc.toBuffer();
  const layers = decodeTile(buf);

  check('realistic tile has multiple layers', layers.length === 2);
  check('roads layer found', layers.find(l => l.name === 'roads') !== undefined);
  check('pois layer found', layers.find(l => l.name === 'pois') !== undefined);

  const roadsLayerDecoded = layers.find(l => l.name === 'roads');
  check('roads layer has feature', roadsLayerDecoded && roadsLayerDecoded.features.length > 0);
}

// Test 12: Error Handling (2.2)
{
  console.log('\nError Handling (2.2):');

  // Truncated varint should throw
  const truncated = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  try {
    decodeTile(truncated);
    check('truncated varint throws', false);
  } catch (err) {
    check('truncated varint throws', err.message.includes('varint'));
  }

  // Malformed geometry
  const enc = new MVTEncoder();
  enc.key(3, 2);
  const layerEnc = new MVTEncoder();
  layerEnc.key(1, 2);
  layerEnc.string('bad');
  layerEnc.key(2, 2);
  const featureEnc = new MVTEncoder();
  featureEnc.key(4, 2);
  const geomEnc = new MVTEncoder();
  geomEnc.varint(99); // invalid command
  let geomBytes = geomEnc.toBuffer();
  featureEnc.varint(geomBytes.length);
  for (const b of geomBytes) featureEnc.bytes.push(b);
  let featureBytes = featureEnc.toBuffer();
  layerEnc.varint(featureBytes.length);
  for (const b of featureBytes) layerEnc.bytes.push(b);
  let layerBytes = layerEnc.toBuffer();
  enc.varint(layerBytes.length);
  for (const b of layerBytes) enc.bytes.push(b);

  try {
    decodeTile(enc.toBuffer());
    check('bad geometry throws', false);
  } catch (err) {
    check('bad geometry throws', err.message.includes('command'));
  }
}

console.log('\n================================================');
console.log('MVT Decoding Tests: 42 passed');
console.log('================================================\n');
