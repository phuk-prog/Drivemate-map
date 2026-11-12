// Renders a DMAP file to a PNG with our own rasteriser and PNG encoder (no libraries).
// Usage: node tools/preview.mjs data/out/london.dmap out.png [width] [height] [--crop=minLon,minLat,maxLon,maxLat]
// Development check only. Not part of the app.

import { readFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { readDmap, fromFixed7 } from "./dmap.mjs";

const [, , inFile, outFile = "preview.png", wArg = "1600", hArg = "1200", cropArg] = process.argv;
const W = Number(wArg);
const H = Number(hArg);

const map = readDmap(await readFile(inFile));
let [minLat, minLon, maxLat, maxLon] = map.bbox.map(fromFixed7);
if (cropArg) {
  const [a, b, c, d] = cropArg.replace("--crop=", "").split(",").map(Number);
  [minLon, minLat, maxLon, maxLat] = [a, b, c, d];
}

// Equirectangular with longitude scaled by cos(latitude) so shapes look right.
const midLat = (minLat + maxLat) / 2;
const kx = Math.cos((midLat * Math.PI) / 180);
const spanX = (maxLon - minLon) * kx;
const spanY = maxLat - minLat;
const scale = Math.min(W / spanX, H / spanY);
const offX = (W - spanX * scale) / 2;
const offY = (H - spanY * scale) / 2;
const project = (latF, lonF) => {
  const lat = fromFixed7(latF);
  const lon = fromFixed7(lonF);
  return [offX + (lon - minLon) * kx * scale, offY + (maxLat - lat) * scale];
};

const img = new Uint8Array(W * H * 3);
img.fill(0);
for (let i = 0; i < img.length; i += 3) {
  img[i] = 242;
  img[i + 1] = 239;
  img[i + 2] = 233;
}
const setPx = (x, y, [r, g, b]) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 3;
  img[o] = r;
  img[o + 1] = g;
  img[o + 2] = b;
};

// Even-odd scanline fill for a set of rings in screen space.
function fillRings(rings, color) {
  const pts = rings.map((ring) => ring.map(([lat, lon]) => project(lat, lon)));
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const ring of pts)
    for (const [, y] of ring) {
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  yMin = Math.max(0, Math.floor(yMin));
  yMax = Math.min(H - 1, Math.ceil(yMax));
  for (let y = yMin; y <= yMax; y++) {
    const cy = y + 0.5;
    const xs = [];
    for (const ring of pts) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        if ((y1 <= cy && y2 > cy) || (y2 <= cy && y1 > cy)) {
          xs.push(x1 + ((cy - y1) * (x2 - x1)) / (y2 - y1));
        }
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(W - 1, Math.floor(xs[k + 1])); x++) {
        setPx(x, y, color);
      }
    }
  }
}

// Thick line by stamping discs along a Bresenham-style walk.
function drawLine(x0, y0, x1, y1, half, color) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  for (let s = 0; s <= steps; s++) {
    const x = x0 + (dx * s) / steps;
    const y = y0 + (dy * s) / steps;
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        if (ox * ox + oy * oy <= half * half + 0.5) setPx(Math.round(x + ox), Math.round(y + oy), color);
      }
    }
  }
}

const POLY_COLORS = { 1: [170, 211, 223], 2: [218, 208, 196], 3: [205, 230, 190] };
for (const p of map.polygons) {
  fillRings(p.rings, POLY_COLORS[p.kind] || [200, 200, 200]);
}

// Road style: colour and half-width in pixels, by road class.
const ROAD_STYLE = {
  1: { color: [233, 120, 120], half: 2 },
  2: { color: [240, 160, 110], half: 2 },
  3: { color: [250, 200, 120], half: 2 },
  4: { color: [250, 225, 150], half: 1 },
  5: { color: [255, 255, 255], half: 1 },
  6: { color: [255, 255, 255], half: 1 },
  7: { color: [235, 235, 235], half: 0 },
  8: { color: [190, 180, 170], half: 0 },
};
const drawOrder = [8, 7, 6, 5, 4, 3, 2, 1];
const byClass = Object.fromEntries(drawOrder.map((c) => [c, []]));
for (const e of map.edges) byClass[e.roadClass].push(e);
for (const c of drawOrder) {
  const style = ROAD_STYLE[c];
  for (const e of byClass[c]) {
    const pts = e.points.map(([lat, lon]) => project(lat, lon));
    for (let i = 0; i < pts.length - 1; i++) {
      drawLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], style.half, style.color);
    }
  }
}

// PNG encoder: 8-bit RGB, filter type 0 per scanline.
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  Buffer.from(img.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 6 })),
  chunk("IEND", Buffer.alloc(0)),
]);
await writeFile(outFile, png);
console.log(`wrote ${outFile} ${W}x${H}, edges ${map.edges.length}, polygons ${map.polygons.length}`);
