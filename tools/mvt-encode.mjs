// Our own Mapbox Vector Tile (MVT) writer, the counterpart of tools/mvt.mjs.
// Written from the public MVT 2.1 specification. No third-party code.
//
// INPUT
//   encodeTile(layers) -> Buffer
//   layers: [{ name, extent?: 4096, features: [{ type: 1|2|3, tags: {}, parts: [[[x, y], ...], ...] }] }]
//     type 1 = point (each part is a list of one or more points; each point becomes one MoveTo)
//     type 2 = line (each part is a polyline, at least 2 points)
//     type 3 = polygon (each part is one ring, given without repeating the first point; the
//              caller orients the rings, this writer does not check it)
//     coordinates are integers inside 0..extent (the caller clips to the tile)
//     tags: string, integer or boolean values only (others are skipped)

const WIRE_VARINT = 0;
const WIRE_BYTES = 2;

function varint(n) {
  const out = [];
  let v = Math.floor(n);
  if (!Number.isFinite(v) || v < 0) throw new Error("MVT: varint must be a non-negative integer");
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function zigzag(n) {
  // Works for the integer range used by tile coordinates and integer tags.
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function key(field, wire) {
  return varint(field * 8 + wire);
}

// Appends by loop, not by spread: spreading a long array into push() overflows the call stack.
function append(dst, src) {
  for (const x of src) dst.push(x);
  return dst;
}

function bytesField(field, data) {
  const out = [];
  append(out, key(field, WIRE_BYTES));
  append(out, varint(data.length));
  append(out, data);
  return out;
}

function varintField(field, n) {
  return [...key(field, WIRE_VARINT), ...varint(n)];
}

function utf8(s) {
  return Array.from(Buffer.from(String(s), "utf8"));
}

// Geometry: a command integer is (id & 7) | (count << 3). Parameters are zigzag deltas.
const CMD_MOVE = 1;
const CMD_LINE = 2;
const CMD_CLOSE = 7;

function encodeGeometry(type, parts) {
  const out = [];
  let cx = 0;
  let cy = 0;
  const param = (x, y) => {
    out.push(...varint(zigzag(x - cx)), ...varint(zigzag(y - cy)));
    cx = x;
    cy = y;
  };
  const command = (id, count) => out.push(...varint((id & 7) | (count << 3)));

  for (const part of parts) {
    if (type === 1) {
      // One MoveTo per point, with all points in one command where possible.
      if (part.length === 0) continue;
      command(CMD_MOVE, part.length);
      for (const [x, y] of part) param(x, y);
    } else if (type === 2) {
      if (part.length < 2) continue;
      command(CMD_MOVE, 1);
      param(part[0][0], part[0][1]);
      command(CMD_LINE, part.length - 1);
      for (let i = 1; i < part.length; i++) param(part[i][0], part[i][1]);
    } else if (type === 3) {
      // Drop a repeated closing point, if the caller gave one.
      let ring = part;
      if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) {
        ring = ring.slice(0, -1);
      }
      if (ring.length < 3) continue;
      command(CMD_MOVE, 1);
      param(ring[0][0], ring[0][1]);
      command(CMD_LINE, ring.length - 1);
      for (let i = 1; i < ring.length; i++) param(ring[i][0], ring[i][1]);
      command(CMD_CLOSE, 1);
    } else {
      throw new Error("MVT: unknown geometry type " + type);
    }
  }
  return out;
}

function encodeValue(v) {
  if (typeof v === "string") return bytesField(1, utf8(v));
  if (typeof v === "boolean") return varintField(7, v ? 1 : 0);
  if (typeof v === "number" && Number.isInteger(v)) {
    return v >= 0 ? varintField(5, v) : varintField(6, zigzag(v));
  }
  return null;
}

function encodeLayer(layer) {
  const keys = [];
  const keyIndex = new Map();
  const values = [];
  const valueIndex = new Map();
  const featureBytes = [];

  const idxOf = (list, map, item, encoded) => {
    const k = encoded ? JSON.stringify(encoded) : item;
    if (map.has(k)) return map.get(k);
    map.set(k, list.length);
    list.push(item);
    return list.length - 1;
  };

  for (const f of layer.features) {
    const tagIds = [];
    for (const [name, value] of Object.entries(f.tags || {})) {
      const enc = encodeValue(value);
      if (enc === null) continue;
      const kIdx = idxOf(keys, keyIndex, name, null);
      const vIdx = idxOf(values, valueIndex, enc, JSON.stringify(enc));
      tagIds.push(kIdx, vIdx);
    }
    const feature = [];
    if (tagIds.length) append(feature, bytesField(2, tagIds.flatMap((n) => varint(n))));
    append(feature, varintField(3, f.type));
    append(feature, bytesField(4, encodeGeometry(f.type, f.parts)));
    featureBytes.push(feature);
  }

  const out = append([], bytesField(1, utf8(layer.name)));
  for (const fb of featureBytes) append(out, bytesField(2, fb));
  for (const k of keys) append(out, bytesField(3, utf8(k)));
  for (const v of values) append(out, bytesField(4, v));
  append(out, varintField(5, layer.extent || 4096));
  append(out, varintField(15, 2));
  return out;
}

/** Encode layers into one tile. Returns a Buffer. */
export function encodeTile(layers) {
  const out = [];
  for (const layer of layers) append(out, bytesField(3, encodeLayer(layer)));
  return Buffer.from(out);
}
