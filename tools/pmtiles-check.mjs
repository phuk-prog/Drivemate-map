// Checks a PMTiles file: reads the header and metadata, lists the vector layers, and decodes a few
// tiles over the centre of the region with tools/mvt.mjs. Exits with 1 when nothing reads back.
// Usage: npm install --no-save pmtiles@3 && node tools/pmtiles-check.mjs data/planetiler/stockport.pmtiles
import { openSync, readSync, fstatSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { PMTiles } from "pmtiles";
import { decodeTile } from "./mvt.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/pmtiles-check.mjs <file.pmtiles>");
  process.exit(2);
}

// A byte source for the pmtiles library, reading a local file.
class FileSource {
  constructor(path) {
    this.path = path;
    this.fd = openSync(path, "r");
    this.size = fstatSync(this.fd).size;
  }
  getKey() {
    return this.path;
  }
  async getBytes(offset, length) {
    const buf = Buffer.alloc(length);
    readSync(this.fd, buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) };
  }
}

const mercatorTile = (lon, lat, z) => {
  const n = 2 ** z;
  const la = (lat * Math.PI) / 180;
  return [
    Math.floor(((lon + 180) / 360) * n),
    Math.floor(((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n),
  ];
};

const source = new FileSource(file);
const pm = new PMTiles(source);
const header = await pm.getHeader();
const metadata = await pm.getMetadata();
const layers = (metadata.vector_layers || []).map((l) => l.id).sort();

const report = {
  file,
  bytes: source.size,
  tileType: header.tileType,
  minZoom: header.minZoom,
  maxZoom: header.maxZoom,
  bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
  layers,
  sample: [],
};

let decoded = 0;
for (const z of [4, 8, 11, 12, 13, 14]) {
  if (z < header.minZoom || z > header.maxZoom) continue;
  const [x, y] = mercatorTile(-2.16, 53.4, z);
  const got = await pm.getZxy(z, x, y);
  if (!got || !got.data) {
    report.sample.push({ z, x, y, tile: "none" });
    continue;
  }
  let bytes = Buffer.from(got.data);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const layersHere = decodeTile(bytes).map((l) => ({ name: l.name, features: l.features.length }));
  decoded++;
  report.sample.push({ z, x, y, bytes: bytes.length, layers: layersHere });
}

console.log(JSON.stringify(report, null, 2));
if (decoded === 0 || layers.length === 0) {
  console.error("no readable tiles or no layers");
  process.exit(1);
}
