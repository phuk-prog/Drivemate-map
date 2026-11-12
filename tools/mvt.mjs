// Our own Mapbox Vector Tile (MVT) reader.
// Written from the public MVT 2.1 specification. No third-party code.
// Decodes a .pbf tile into layers, features, tags and geometry in tile coordinates.

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  done() {
    return this.pos >= this.end;
  }

  varint() {
    let result = 0;
    let factor = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error("MVT: truncated varint");
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * factor;
      if ((b & 0x80) === 0) return result;
      factor *= 128;
    }
    throw new Error("MVT: varint too long");
  }

  key() {
    const k = this.varint();
    return [Math.floor(k / 8), k % 8];
  }

  bytes() {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error("MVT: length past end");
    return new Reader(this.buf, start, start + len);
  }

  fixed64Double() {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  fixed32Float() {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  skip(wire) {
    if (wire === WIRE_VARINT) this.varint();
    else if (wire === WIRE_FIXED64) this.pos += 8;
    else if (wire === WIRE_BYTES) this.pos += this.varint();
    else if (wire === WIRE_FIXED32) this.pos += 4;
    else throw new Error("MVT: unknown wire type " + wire);
  }
}

function zigzag(n) {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

function decodeGeometry(reader, geomType) {
  // Returns an array of parts. Each part is an array of [x, y] in tile units.
  // Lines: one part per MoveTo. Polygons: one part per ring (closing point added).
  const parts = [];
  let x = 0;
  let y = 0;
  let current = null;
  while (!reader.done()) {
    const cmd = reader.varint();
    const id = cmd & 7;
    const count = Math.floor(cmd / 8);
    if (id === 1 || id === 2) {
      for (let i = 0; i < count; i++) {
        x += zigzag(reader.varint());
        y += zigzag(reader.varint());
        if (id === 1) {
          current = [[x, y]];
          parts.push(current);
        } else {
          current.push([x, y]);
        }
      }
    } else if (id === 7) {
      if (current && current.length > 0) {
        const first = current[0];
        current.push([first[0], first[1]]);
      }
    } else {
      throw new Error("MVT: bad geometry command " + id);
    }
  }
  return parts;
}

function readFeature(r, keys, values, layerInfo) {
  const feature = { id: null, type: 0, tags: {}, parts: [] };
  let tagIds = [];
  let geomReader = null;
  while (!r.done()) {
    const [field, wire] = r.key();
    if (field === 1 && wire === WIRE_VARINT) {
      feature.id = r.varint();
    } else if (field === 2 && wire === WIRE_BYTES) {
      const sub = r.bytes();
      while (!sub.done()) tagIds.push(sub.varint());
    } else if (field === 3 && wire === WIRE_VARINT) {
      feature.type = r.varint();
    } else if (field === 4 && wire === WIRE_BYTES) {
      geomReader = r.bytes();
    } else {
      r.skip(wire);
    }
  }
  for (let i = 0; i + 1 < tagIds.length; i += 2) {
    const k = keys[tagIds[i]];
    const v = values[tagIds[i + 1]];
    if (k !== undefined) feature.tags[k] = v;
  }
  if (geomReader) feature.parts = decodeGeometry(geomReader, feature.type);
  return feature;
}

function readLayer(r) {
  const layer = { name: "", extent: 4096, features: [] };
  const keys = [];
  const values = [];
  const featureBytes = [];
  while (!r.done()) {
    const [field, wire] = r.key();
    if (field === 1 && wire === WIRE_BYTES) {
      const sub = r.bytes();
      layer.name = sub.buf.toString("utf8", sub.pos, sub.end);
    } else if (field === 2 && wire === WIRE_BYTES) {
      featureBytes.push(r.bytes());
    } else if (field === 3 && wire === WIRE_BYTES) {
      const sub = r.bytes();
      keys.push(sub.buf.toString("utf8", sub.pos, sub.end));
    } else if (field === 4 && wire === WIRE_BYTES) {
      values.push(readValueFromReader(r.bytes()));
    } else if (field === 5 && wire === WIRE_VARINT) {
      layer.extent = r.varint();
    } else {
      r.skip(wire);
    }
  }
  for (const fr of featureBytes) {
    layer.features.push(readFeature(fr, keys, values, layer));
  }
  return layer;
}

function readValueFromReader(sub) {
  let value = null;
  while (!sub.done()) {
    const [field, wire] = sub.key();
    if (field === 1 && wire === WIRE_BYTES) {
      const s = sub.bytes();
      value = s.buf.toString("utf8", s.pos, s.end);
    } else if (field === 2 && wire === WIRE_FIXED32) {
      value = sub.fixed32Float();
    } else if (field === 3 && wire === WIRE_FIXED64) {
      value = sub.fixed64Double();
    } else if (field === 4 && wire === WIRE_VARINT) {
      value = sub.varint();
    } else if (field === 5 && wire === WIRE_VARINT) {
      value = sub.varint();
    } else if (field === 6 && wire === WIRE_VARINT) {
      value = zigzag(sub.varint());
    } else if (field === 7 && wire === WIRE_VARINT) {
      value = sub.varint() !== 0;
    } else {
      sub.skip(wire);
    }
  }
  return value;
}

// Decode a whole tile. Returns an array of layers.
export function decodeTile(buf) {
  const r = new Reader(buf);
  const layers = [];
  while (!r.done()) {
    const [field, wire] = r.key();
    if (field === 3 && wire === WIRE_BYTES) layers.push(readLayer(r.bytes()));
    else r.skip(wire);
  }
  return layers;
}
