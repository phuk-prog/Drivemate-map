// Our own reader for OpenStreetMap .osm.pbf files (the format Geofabrik publishes).
// Written from the public OSM PBF format description. No third-party code; uses only Node's
// built-in zlib to inflate compressed blocks.
//
// A file is a sequence of blocks: [4-byte big-endian length][BlobHeader][Blob]. Each Blob holds
// a zlib-compressed HeaderBlock or PrimitiveBlock. A PrimitiveBlock holds a string table and
// groups of nodes, dense nodes, ways and relations.
//
// Elements are passed to callbacks one by one, so large files never need to fit in memory:
//   node:     { type: "node", id, lat, lon, tags }
//   way:      { type: "way", id, tags, nodes: [node ids] }
//   relation: { type: "relation", id, tags, members: [{ type, ref, role }] }

import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { inflateSync } from "node:zlib";

const TWO_64 = 18446744073709551616; // 2^64
const TWO_63 = 9223372036854775808; // 2^63

class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  done() {
    return this.pos >= this.end;
  }

  // Unsigned varint as a Number. Exact up to 2^53, which covers OSM ids and coordinates.
  varint() {
    let result = 0;
    let factor = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error("PBF: truncated varint");
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * factor;
      if ((b & 0x80) === 0) return result;
      factor *= 128;
    }
    throw new Error("PBF: varint too long");
  }

  // Signed int64 stored as plain (two's complement) varint, such as lat_offset.
  int64() {
    const v = this.varint();
    return v >= TWO_63 ? v - TWO_64 : v;
  }

  // Signed zigzag varint (sint32 / sint64).
  sint() {
    return zigzag(this.varint());
  }

  key() {
    const k = this.varint();
    return [Math.floor(k / 8), k % 8];
  }

  sub() {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error("PBF: field runs past end");
    return new Reader(this.buf, start, start + len);
  }

  string() {
    const len = this.varint();
    const s = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const len = this.varint(); // read the length first: "pos += varint()" would lose the length bytes
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error("PBF: unknown wire type " + wire);
  }

  // Packed repeated varints. decode() turns each raw varint into its value.
  packed(decode) {
    const r = this.sub();
    const out = [];
    while (!r.done()) out.push(decode(r));
    return out;
  }
}

function zigzag(n) {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

const asUint = (r) => r.varint();
const asSint = (r) => r.sint();

function decodeBlob(buf) {
  const r = new Reader(buf);
  let raw = null;
  let zlib = null;
  while (!r.done()) {
    const [field, wire] = r.key();
    if (field === 1 && wire === 2) {
      const s = r.sub();
      raw = buf.subarray(s.pos, s.end);
    } else if (field === 3 && wire === 2) {
      const s = r.sub();
      zlib = buf.subarray(s.pos, s.end);
    } else if ((field === 4 || field === 6 || field === 7) && wire === 2) {
      throw new Error("PBF: only raw and zlib blocks are supported (found lzma/lz4/zstd)");
    } else {
      r.skip(wire);
    }
  }
  if (raw) return raw;
  if (zlib) return inflateSync(zlib);
  return Buffer.alloc(0);
}

function readBlobHeader(buf) {
  const r = new Reader(buf);
  let type = "";
  let datasize = 0;
  while (!r.done()) {
    const [field, wire] = r.key();
    if (field === 1 && wire === 2) type = r.string();
    else if (field === 3 && wire === 0) datasize = r.varint();
    else r.skip(wire);
  }
  return { type, datasize };
}

function tagsFrom(keys, vals, strings) {
  const tags = {};
  for (let i = 0; i < keys.length; i++) tags[strings[keys[i]]] = strings[vals[i]];
  return tags;
}

function readPrimitiveBlock(buf, handlers) {
  const r = new Reader(buf);
  let strings = [];
  const groups = [];
  let granularity = 100;
  let latOffset = 0;
  let lonOffset = 0;
  while (!r.done()) {
    const [field, wire] = r.key();
    if (field === 1 && wire === 2) {
      const st = r.sub();
      strings = [];
      while (!st.done()) {
        const [f, w] = st.key();
        if (f === 1 && w === 2) strings.push(st.string());
        else st.skip(w);
      }
    } else if (field === 2 && wire === 2) {
      groups.push(r.sub());
    } else if (field === 17 && wire === 0) {
      granularity = r.varint();
    } else if (field === 19 && wire === 0) {
      latOffset = r.int64();
    } else if (field === 20 && wire === 0) {
      lonOffset = r.int64();
    } else {
      r.skip(wire);
    }
  }
  // Coordinates are stored in nanodegrees: degrees = 1e-9 * (offset + granularity * value).
  const lat = (v) => (latOffset + granularity * v) / 1e9;
  const lon = (v) => (lonOffset + granularity * v) / 1e9;

  for (const g of groups) {
    while (!g.done()) {
      const [field, wire] = g.key();
      if (field === 1 && wire === 2) readNode(g.sub(), strings, lat, lon, handlers);
      else if (field === 2 && wire === 2) readDense(g.sub(), strings, lat, lon, handlers);
      else if (field === 3 && wire === 2) readWay(g.sub(), strings, handlers);
      else if (field === 4 && wire === 2) readRelation(g.sub(), strings, handlers);
      else g.skip(wire);
    }
  }
}

function readNode(r, strings, lat, lon, handlers) {
  if (!handlers.node) return;
  let id = 0;
  let keys = [];
  let vals = [];
  let la = 0;
  let lo = 0;
  while (!r.done()) {
    const [field, wire] = r.key();
    if (field === 1 && wire === 0) id = r.sint();
    else if (field === 2 && wire === 2) keys = r.packed(asUint);
    else if (field === 3 && wire === 2) vals = r.packed(asUint);
    else if (field === 8 && wire === 0) la = r.sint();
    else if (field === 9 && wire === 0) lo = r.sint();
    else r.skip(wire);
  }
  handlers.node({ type: "node", id, lat: lat(la), lon: lon(lo), tags: tagsFrom(keys, vals, strings) });
}

function readDense(r, strings, lat, lon, handlers) {
  if (!handlers.node) return;
  let ids = [];
  let lats = [];
  let lons = [];
  let keysVals = [];
  while (!r.done()) {
    const [field, wire] = r.key();
    if (field === 1 && wire === 2) ids = r.packed(asSint);
    else if (field === 8 && wire === 2) lats = r.packed(asSint);
    else if (field === 9 && wire === 2) lons = r.packed(asSint);
    else if (field === 10 && wire === 2) keysVals = r.packed(asUint);
    else r.skip(wire);
  }
  // Ids and coordinates are delta-coded. keys_vals lists key,value pairs per node, ending in 0.
  let id = 0;
  let la = 0;
  let lo = 0;
  let kv = 0;
  for (let i = 0; i < ids.length; i++) {
    id += ids[i];
    la += lats[i];
    lo += lons[i];
    const tags = {};
    if (keysVals.length) {
      while (kv < keysVals.length && keysVals[kv] !== 0) {
        tags[strings[keysVals[kv]]] = strings[keysVals[kv + 1]];
        kv += 2;
      }
      kv++; // skip the 0 that ends this node's tags
    }
    handlers.node({ type: "node", id, lat: lat(la), lon: lon(lo), tags });
  }
}

function readWay(r, strings, handlers) {
  if (!handlers.way) return;
  let id = 0;
  let keys = [];
  let vals = [];
  let refs = [];
  while (!r.done()) {
    const [field, wire] = r.key();
    if (field === 1 && wire === 0) id = r.varint();
    else if (field === 2 && wire === 2) keys = r.packed(asUint);
    else if (field === 3 && wire === 2) vals = r.packed(asUint);
    else if (field === 8 && wire === 2) refs = r.packed(asSint);
    else r.skip(wire);
  }
  const nodes = new Array(refs.length);
  let ref = 0;
  for (let i = 0; i < refs.length; i++) {
    ref += refs[i];
    nodes[i] = ref;
  }
  handlers.way({ type: "way", id, tags: tagsFrom(keys, vals, strings), nodes });
}

const MEMBER_TYPES = ["node", "way", "relation"];

function readRelation(r, strings, handlers) {
  if (!handlers.relation) return;
  let id = 0;
  let keys = [];
  let vals = [];
  let roles = [];
  let memids = [];
  let types = [];
  while (!r.done()) {
    const [field, wire] = r.key();
    if (field === 1 && wire === 0) id = r.varint();
    else if (field === 2 && wire === 2) keys = r.packed(asUint);
    else if (field === 3 && wire === 2) vals = r.packed(asUint);
    else if (field === 8 && wire === 2) roles = r.packed(asUint);
    else if (field === 9 && wire === 2) memids = r.packed(asSint);
    else if (field === 10 && wire === 2) types = r.packed(asUint);
    else r.skip(wire);
  }
  const members = new Array(memids.length);
  let ref = 0;
  for (let i = 0; i < memids.length; i++) {
    ref += memids[i];
    members[i] = { type: MEMBER_TYPES[types[i]] ?? "unknown", ref, role: strings[roles[i]] ?? "" };
  }
  handlers.relation({ type: "relation", id, tags: tagsFrom(keys, vals, strings), members });
}

// Reads a whole .osm.pbf held in memory.
export function readPbfBuffer(buf, handlers) {
  let pos = 0;
  while (pos < buf.length) {
    const headerLen = buf.readUInt32BE(pos);
    pos += 4;
    const header = readBlobHeader(buf.subarray(pos, pos + headerLen));
    pos += headerLen;
    const blob = buf.subarray(pos, pos + header.datasize);
    pos += header.datasize;
    if (header.type === "OSMData") readPrimitiveBlock(decodeBlob(blob), handlers);
  }
}

// Reads a .osm.pbf file block by block, so the whole file is never held in memory.
export function readPbfFile(path, handlers) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let pos = 0;
    const lenBuf = Buffer.alloc(4);
    while (pos < size) {
      readSync(fd, lenBuf, 0, 4, pos);
      pos += 4;
      const headerLen = lenBuf.readUInt32BE(0);
      const headerBuf = Buffer.alloc(headerLen);
      readSync(fd, headerBuf, 0, headerLen, pos);
      pos += headerLen;
      const header = readBlobHeader(headerBuf);
      const blobBuf = Buffer.alloc(header.datasize);
      readSync(fd, blobBuf, 0, header.datasize, pos);
      pos += header.datasize;
      if (header.type === "OSMData") readPrimitiveBlock(decodeBlob(blobBuf), handlers);
    }
  } finally {
    closeSync(fd);
  }
}
