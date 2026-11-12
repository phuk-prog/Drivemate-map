// Reader and writer for the DMAP map format (see format/FORMAT.md).
// Our own code. No third-party dependencies.

const MAGIC = "DMAP";
const VERSION = 1;
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

export function writeDmap(model) {
  const { bbox, nodes, edges, polygons, labels } = model;
  const w = new ByteWriter();
  w.bytes(Buffer.from(MAGIC, "ascii"));
  w.u16(VERSION);
  w.u16(0);
  for (const v of bbox) w.i32(v);
  w.u32(nodes.length);
  w.u32(edges.length);
  w.u32(polygons.length);
  w.u32(labels.length);

  for (const n of nodes) {
    w.i32(n.lat);
    w.i32(n.lon);
  }

  for (const e of edges) {
    w.u32(e.from);
    w.u32(e.to);
    w.u8(e.roadClass);
    w.u8(e.flags);
    w.u16(e.points.length);
    for (const [lat, lon] of e.points) {
      w.i32(lat);
      w.i32(lon);
    }
  }

  for (const p of polygons) {
    w.u8(p.kind);
    w.u16(p.rings.length);
    for (const ring of p.rings) {
      w.u32(ring.length);
      for (const [lat, lon] of ring) {
        w.i32(lat);
        w.i32(lon);
      }
    }
  }

  for (const l of labels) {
    const name = Buffer.from(l.name, "utf8").subarray(0, 255);
    w.u8(l.kind);
    w.i32(l.lat);
    w.i32(l.lon);
    w.u8(name.length);
    w.bytes(name);
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

  if (buf.toString("ascii", 0, 4) !== MAGIC) throw new Error("DMAP: bad magic");
  pos = 4;
  const version = u16();
  if (version !== VERSION) throw new Error("DMAP: unsupported version " + version);
  u16();
  const bbox = [i32(), i32(), i32(), i32()];
  const nodeCount = u32();
  const edgeCount = u32();
  const polygonCount = u32();
  const labelCount = u32();

  const nodes = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) nodes[i] = { lat: i32(), lon: i32() };

  const edges = new Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    const from = u32();
    const to = u32();
    const roadClass = u8();
    const flags = u8();
    const n = u16();
    const points = new Array(n);
    for (let k = 0; k < n; k++) points[k] = [i32(), i32()];
    edges[i] = { from, to, roadClass, flags, points };
  }

  const polygons = new Array(polygonCount);
  for (let i = 0; i < polygonCount; i++) {
    const kind = u8();
    const ringCount = u16();
    const rings = new Array(ringCount);
    for (let r = 0; r < ringCount; r++) {
      const n = u32();
      const ring = new Array(n);
      for (let k = 0; k < n; k++) ring[k] = [i32(), i32()];
      rings[r] = ring;
    }
    polygons[i] = { kind, rings };
  }

  const labels = new Array(labelCount);
  for (let i = 0; i < labelCount; i++) {
    const kind = u8();
    const lat = i32();
    const lon = i32();
    const len = u8();
    need(len);
    const name = buf.toString("utf8", pos, pos + len);
    pos += len;
    labels[i] = { kind, lat, lon, name };
  }

  return { bbox, nodes, edges, polygons, labels };
}
