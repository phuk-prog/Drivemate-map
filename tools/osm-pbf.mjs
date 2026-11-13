// Reader for OpenStreetMap .osm.pbf extract files (for example from Geofabrik).
// Our own code. No third-party dependencies: only Node's built-in zlib and fs.
//
// A .osm.pbf file is a series of blocks: [4-byte length][BlobHeader][Blob]. Each OSMData
// blob holds a PrimitiveBlock with a string table and groups of nodes, ways and relations.
// This reader streams the file block by block and calls handlers for the kinds you ask for.
//
//   await readPbf(path, {
//     onNode(id, lat, lon),         // lat and lon in 1e-7 degree units (the map's fixed-point)
//     onWay(way, block),            // way = { id, keys, vals, refs }; block.str(i) gives a string
//     onRelation(rel, block),       // rel = { id, keys, vals, roles, memids, types }
//   });
//
// Keys, vals and roles are indexes into the block's string table. Use block.find(name) to
// get the index of a string (or -1) and block.str(index) to read one.
//
// Not supported: coordinate offsets other than zero (never used by real extracts), and
// blobs compressed with anything other than zlib or stored raw.

import { open } from "node:fs/promises";
import { inflateSync } from "node:zlib";

class Pb {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  more() {
    return this.pos < this.end;
  }

  // Varint as a number. Exact up to 2^53, which covers ids and coordinates.
  varint() {
    let result = 0;
    let mul = 1;
    let b;
    do {
      b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return result;
  }

  bytes() {
    const len = this.varint();
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      // Read the length first: `this.pos += this.varint()` would use the old position.
      const len = this.varint();
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error("PBF: bad wire type " + wire);
  }
}

const zigzag = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

// Packed repeated varints, as numbers. With signed, each value is zigzag-decoded.
function packed(buf, signed) {
  const out = [];
  const r = new Pb(buf);
  while (r.more()) {
    const v = r.varint();
    out.push(signed ? zigzag(v) : v);
  }
  return out;
}

// Turns delta-coded values into absolute values.
function undelta(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    values[i] = sum;
  }
  return values;
}

function parseDense(buf, granularity, onNode) {
  const r = new Pb(buf);
  let ids = null;
  let lats = null;
  let lons = null;
  while (r.more()) {
    const t = r.varint();
    const f = t >>> 3;
    const w = t & 7;
    if (f === 1 && w === 2) ids = undelta(packed(r.bytes(), true));
    else if (f === 8 && w === 2) lats = undelta(packed(r.bytes(), true));
    else if (f === 9 && w === 2) lons = undelta(packed(r.bytes(), true));
    else r.skip(w);
  }
  if (!ids || !lats || !lons) return;
  // Raw units are granularity nanodegrees; the map uses 1e-7 degrees, which is 100 nanodegrees.
  const scale = granularity / 100;
  for (let i = 0; i < ids.length; i++) {
    onNode(ids[i], Math.round(lats[i] * scale), Math.round(lons[i] * scale));
  }
}

function parseWay(buf) {
  const r = new Pb(buf);
  const way = { id: 0, keys: [], vals: [], refs: [] };
  while (r.more()) {
    const t = r.varint();
    const f = t >>> 3;
    const w = t & 7;
    if (f === 1 && w === 0) way.id = r.varint();
    else if (f === 2 && w === 2) way.keys = packed(r.bytes(), false);
    else if (f === 3 && w === 2) way.vals = packed(r.bytes(), false);
    else if (f === 8 && w === 2) way.refs = undelta(packed(r.bytes(), true));
    else r.skip(w);
  }
  return way;
}

function parseRelation(buf) {
  const r = new Pb(buf);
  const rel = { id: 0, keys: [], vals: [], roles: [], memids: [], types: [] };
  while (r.more()) {
    const t = r.varint();
    const f = t >>> 3;
    const w = t & 7;
    if (f === 1 && w === 0) rel.id = r.varint();
    else if (f === 2 && w === 2) rel.keys = packed(r.bytes(), false);
    else if (f === 3 && w === 2) rel.vals = packed(r.bytes(), false);
    else if (f === 8 && w === 2) rel.roles = packed(r.bytes(), false);
    else if (f === 9 && w === 2) rel.memids = undelta(packed(r.bytes(), true));
    else if (f === 10 && w === 2) rel.types = packed(r.bytes(), false); // 0 node, 1 way, 2 relation
    else r.skip(w);
  }
  return rel;
}

function parseBlock(buf, handlers) {
  const r = new Pb(buf);
  const strings = [];
  const groups = [];
  let granularity = 100;
  let latOffset = 0;
  let lonOffset = 0;
  while (r.more()) {
    const t = r.varint();
    const f = t >>> 3;
    const w = t & 7;
    if (f === 1 && w === 2) {
      const sr = new Pb(r.bytes());
      while (sr.more()) {
        const st = sr.varint();
        if (st >>> 3 === 1) strings.push(sr.bytes());
        else sr.skip(st & 7);
      }
    } else if (f === 2 && w === 2) groups.push(r.bytes());
    else if (f === 17 && w === 0) granularity = r.varint();
    else if (f === 19 && w === 0) latOffset = r.varint();
    else if (f === 20 && w === 0) lonOffset = r.varint();
    else r.skip(w);
  }
  if (latOffset !== 0 || lonOffset !== 0) throw new Error("PBF: coordinate offsets are not supported");

  const decoded = new Array(strings.length);
  const found = new Map();
  const block = {
    str(i) {
      return decoded[i] ?? (decoded[i] = strings[i].toString("utf8"));
    },
    // Index of a string in the table, or -1.
    find(name) {
      if (found.has(name)) return found.get(name);
      const want = Buffer.from(name, "utf8");
      let at = -1;
      for (let i = 0; i < strings.length; i++) {
        if (strings[i].equals(want)) {
          at = i;
          break;
        }
      }
      found.set(name, at);
      return at;
    },
  };

  for (const g of groups) {
    const gr = new Pb(g);
    while (gr.more()) {
      const t = gr.varint();
      const f = t >>> 3;
      const w = t & 7;
      if (f === 2 && w === 2 && handlers.onNode) parseDense(gr.bytes(), granularity, handlers.onNode);
      else if (f === 3 && w === 2 && handlers.onWay) handlers.onWay(parseWay(gr.bytes()), block);
      else if (f === 4 && w === 2 && handlers.onRelation) handlers.onRelation(parseRelation(gr.bytes()), block);
      else gr.skip(w);
    }
  }
}

async function readFull(fh, length, position) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw new Error("PBF: unexpected end of file");
    done += bytesRead;
  }
  return buf;
}

export async function readPbf(path, handlers) {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    let pos = 0;
    while (pos < size) {
      const hlen = (await readFull(fh, 4, pos)).readUInt32BE(0);
      pos += 4;
      const header = new Pb(await readFull(fh, hlen, pos));
      pos += hlen;
      let type = "";
      let dataSize = 0;
      while (header.more()) {
        const t = header.varint();
        const f = t >>> 3;
        const w = t & 7;
        if (f === 1 && w === 2) type = header.bytes().toString("ascii");
        else if (f === 3 && w === 0) dataSize = header.varint();
        else header.skip(w);
      }
      const blob = new Pb(await readFull(fh, dataSize, pos));
      pos += dataSize;
      if (type !== "OSMData") continue;

      let raw = null;
      let zlibData = null;
      while (blob.more()) {
        const t = blob.varint();
        const f = t >>> 3;
        const w = t & 7;
        if (f === 1 && w === 2) raw = blob.bytes();
        else if (f === 3 && w === 2) zlibData = blob.bytes();
        else if (w === 2 && (f === 4 || f === 5 || f === 6 || f === 7)) throw new Error("PBF: unsupported blob compression");
        else blob.skip(w);
      }
      const data = raw ?? (zlibData ? inflateSync(zlibData) : null);
      if (!data) throw new Error("PBF: blob has no data");
      parseBlock(data, handlers);
    }
  } finally {
    await fh.close();
  }
}
