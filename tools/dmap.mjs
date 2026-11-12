// Reader and writer for the DMAP map format (see format/FORMAT.md).
// Writes version 4. Reads versions 3 and 4. Our own code. No third-party dependencies.

const MAGIC = "DMAP";
const VERSION = 4;
const COORD_SCALE = 1e7;

export function toFixed7(deg) {
  return Math.round(deg * COORD_SCALE);
}

export function fromFixed7(v) {
  return v / COORD_SCALE;
}

export class ByteWriter {
  constructor(initial = 1 << 20) {
    this.buf = Buffer.alloc(initial);
    this.pos = 0;
  }

  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = Buffer.alloc(size);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }

  u8(v) {
    this.ensure(1);
    this.buf.writeUInt8(v, this.pos);
    this.pos += 1;
  }

  u16(v) {
    this.ensure(2);
    this.buf.writeUInt16LE(v, this.pos);
    this.pos += 2;
  }

  u32(v) {
    this.ensure(4);
    this.buf.writeUInt32LE(v, this.pos);
    this.pos += 4;
  }

  i32(v) {
    this.ensure(4);
    this.buf.writeInt32LE(v, this.pos);
    this.pos += 4;
  }

  bytes(b) {
    this.ensure(b.length);
    b.copy(this.buf, this.pos);
    this.pos += b.length;
  }

  result() {
    return this.buf.subarray(0, this.pos);
  }
}

function writePoints(w, points) {
  for (const [lat, lon] of points) {
    w.i32(lat);
    w.i32(lon);
  }
}

// model: { bbox, nodes, edges, lines, polygons, labels, strings?, restrictions? }
// Edge extras (all optional, default 0): maxspeed, lanes, name, ref, turnLanesFwd, turnLanesBwd.
// name/ref/turnLanes are indices into strings, where index 0 is the empty string.
export function writeDmap(model) {
  const { bbox, nodes, edges, lines, polygons, labels } = model;
  const strings = model.strings && model.strings.length ? model.strings : [""];
  const restrictions = model.restrictions ?? [];
  const w = new ByteWriter();
  w.bytes(Buffer.from(MAGIC, "ascii"));
  w.u16(VERSION);
  w.u16(0);
  for (const v of bbox) w.i32(v);
  w.u32(nodes.length);
  w.u32(edges.length);
  w.u32(lines.length);
  w.u32(polygons.length);
  w.u32(labels.length);
  w.u32(strings.length);
  w.u32(restrictions.length);

  for (const s of strings) {
    const b = Buffer.from(s, "utf8").subarray(0, 65535);
    w.u16(b.length);
    w.bytes(b);
  }

  for (const n of nodes) {
    w.i32(n.lat);
    w.i32(n.lon);
  }

  for (const e of edges) {
    w.u32(e.from);
    w.u32(e.to);
    w.u8(e.roadClass);
    w.u8(e.flags);
    w.u8(e.maxspeed ?? 0);
    w.u8(e.lanes ?? 0);
    w.u32(e.name ?? 0);
    w.u32(e.ref ?? 0);
    w.u32(e.turnLanesFwd ?? 0);
    w.u32(e.turnLanesBwd ?? 0);
    w.u16(e.points.length);
    writePoints(w, e.points);
  }

  for (const l of lines) {
    w.u8(l.kind);
    w.u8(l.level);
    w.u32(l.points.length);
    writePoints(w, l.points);
  }

  for (const p of polygons) {
    w.u8(p.kind);
    w.u16(p.height ?? 0);
    w.u16(p.minHeight ?? 0);
    const c = p.colour ?? 0;
    w.u8((c >> 16) & 255);
    w.u8((c >> 8) & 255);
    w.u8(c & 255);
    w.u16(p.rings.length);
    for (const ring of p.rings) {
      w.u32(ring.length);
      writePoints(w, ring);
    }
  }

  for (const l of labels) {
    const name = Buffer.from(l.name, "utf8").subarray(0, 255);
    w.u8(l.kind);
    w.u8(l.category);
    w.i32(l.lat);
    w.i32(l.lon);
    w.u8(name.length);
    w.bytes(name);
  }

  for (const r of restrictions) {
    w.u32(r.fromEdge);
    w.u32(r.viaNode);
    w.u32(r.toEdge);
    w.u8(r.kind);
  }

  return w.result();
}

export function readDmap(buf) {
  let pos = 0;
  const need = (n) => {
    if (pos + n > buf.length) throw new Error("DMAP: truncated file");
  };
  const u8 = () => {
    need(1);
    const v = buf.readUInt8(pos);
    pos += 1;
    return v;
  };
  const u16 = () => {
    need(2);
    const v = buf.readUInt16LE(pos);
    pos += 2;
    return v;
  };
  const u32 = () => {
    need(4);
    const v = buf.readUInt32LE(pos);
    pos += 4;
    return v;
  };
  const i32 = () => {
    need(4);
    const v = buf.readInt32LE(pos);
    pos += 4;
    return v;
  };
  const points = (n) => {
    need(n * 8);
    const out = new Array(n);
    for (let k = 0; k < n; k++) out[k] = [i32(), i32()];
    return out;
  };

  if (buf.toString("ascii", 0, 4) !== MAGIC) throw new Error("DMAP: bad magic");
  pos = 4;
  const version = u16();
  if (version !== 3 && version !== 4) throw new Error("DMAP: unsupported version " + version);
  u16();
  const bbox = [i32(), i32(), i32(), i32()];
  const nodeCount = u32();
  const edgeCount = u32();
  const lineCount = u32();
  const polygonCount = u32();
  const labelCount = u32();
  const stringCount = version >= 4 ? u32() : 0;
  const restrictionCount = version >= 4 ? u32() : 0;

  const strings = new Array(stringCount);
  for (let i = 0; i < stringCount; i++) {
    const len = u16();
    need(len);
    strings[i] = buf.toString("utf8", pos, pos + len);
    pos += len;
  }
  if (strings.length === 0) strings.push("");

  const nodes = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) nodes[i] = { lat: i32(), lon: i32() };

  const edges = new Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    const from = u32();
    const to = u32();
    const roadClass = u8();
    const flags = u8();
    let maxspeed = 0;
    let lanes = 0;
    let name = 0;
    let ref = 0;
    let turnLanesFwd = 0;
    let turnLanesBwd = 0;
    if (version >= 4) {
      maxspeed = u8();
      lanes = u8();
      name = u32();
      ref = u32();
      turnLanesFwd = u32();
      turnLanesBwd = u32();
    }
    const n = u16();
    edges[i] = { from, to, roadClass, flags, maxspeed, lanes, name, ref, turnLanesFwd, turnLanesBwd, points: points(n) };
  }

  const lines = new Array(lineCount);
  for (let i = 0; i < lineCount; i++) {
    const kind = u8();
    const level = u8();
    const n = u32();
    lines[i] = { kind, level, points: points(n) };
  }

  const polygons = new Array(polygonCount);
  for (let i = 0; i < polygonCount; i++) {
    const kind = u8();
    const height = u16();
    const minHeight = u16();
    const colour = (u8() << 16) | (u8() << 8) | u8();
    const ringCount = u16();
    const rings = new Array(ringCount);
    for (let r = 0; r < ringCount; r++) rings[r] = points(u32());
    polygons[i] = { kind, height, minHeight, colour, rings };
  }

  const labels = new Array(labelCount);
  for (let i = 0; i < labelCount; i++) {
    const kind = u8();
    const category = u8();
    const lat = i32();
    const lon = i32();
    const len = u8();
    need(len);
    const name = buf.toString("utf8", pos, pos + len);
    pos += len;
    labels[i] = { kind, category, lat, lon, name };
  }

  const restrictions = new Array(restrictionCount);
  for (let i = 0; i < restrictionCount; i++) {
    restrictions[i] = { fromEdge: u32(), viaNode: u32(), toEdge: u32(), kind: u8() };
  }

  return { version, bbox, nodes, edges, lines, polygons, labels, strings, restrictions };
}
