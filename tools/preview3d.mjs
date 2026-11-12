// Renders a DMAP file as a tilted 3D view with extruded buildings, using our own projection,
// rasteriser and PNG encoder. Development check only. Not part of the app.
// Usage: node tools/preview3d.mjs data/out/london.dmap out.png [width] [height] [--crop=minLon,minLat,maxLon,maxLat] [--tilt=55]

import { readFile, writeFile } from "node:fs/promises";
import { readDmap, fromFixed7 } from "./dmap.mjs";
import { encodePng } from "./png.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const [inFile, outFile = "preview3d.png", wArg = "1600", hArg = "1200"] = args.filter((a) => !a.startsWith("--"));
const W = Number(wArg);
const H = Number(hArg);
const tiltDeg = Number(opt("tilt", "55"));

const map = readDmap(await readFile(inFile));
let [minLat, minLon, maxLat, maxLon] = map.bbox.map(fromFixed7);
const cropArg = opt("crop", "");
if (cropArg) {
  const [a, b, c, d] = cropArg.split(",").map(Number);
  [minLon, minLat, maxLon, maxLat] = [a, b, c, d];
}

// Local metric frame centred on the crop: X east, Y north, Z up, all in metres.
const cLat = (minLat + maxLat) / 2;
const cLon = (minLon + maxLon) / 2;
const MX = 111320 * Math.cos((cLat * Math.PI) / 180);
const MY = 110574;
const toXY = (latF, lonF) => [(fromFixed7(lonF) - cLon) * MX, (fromFixed7(latF) - cLat) * MY];
const spanX = (maxLon - minLon) * MX;
const spanY = (maxLat - minLat) * MY;

// Camera looks at the origin from distance D, tilted by the given angle from vertical.
const th = (tiltDeg * Math.PI) / 180;
const sinT = Math.sin(th);
const cosT = Math.cos(th);
const D = 1.6 * Math.max(spanX, spanY) + 1000;
const Cy = -D * cosT;
const Cz = D * sinT;
function camera(X, Y, Z) {
  const ry = Y - Cy;
  const rz = Z - Cz;
  const xc = X;
  const yc = sinT * ry + cosT * rz;
  const zc = cosT * ry - sinT * rz;
  return [xc / zc, yc / zc];
}

// Fit the scene on screen: project the ground corners and the tallest point, then scale.
let F = 1;
let ox = 0;
let oy = 0;
{
  const corners = [
    [-spanX / 2, -spanY / 2, 0],
    [spanX / 2, -spanY / 2, 0],
    [-spanX / 2, spanY / 2, 0],
    [spanX / 2, spanY / 2, 0],
    [0, 0, 400],
  ];
  const pts = corners.map(([X, Y, Z]) => camera(X, Y, Z));
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxY = Math.max(...pts.map((p) => p[1]));
  F = Math.min((W * 0.94) / (maxX - minX), (H * 0.94) / (maxY - minY));
  ox = W / 2 - ((minX + maxX) / 2) * F;
  oy = H / 2 + ((minY + maxY) / 2) * F;
}
const project = (X, Y, Z) => {
  const [x, y] = camera(X, Y, Z);
  return [ox + x * F, oy - y * F];
};

const img = new Uint8Array(W * H * 3);
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

// Fill one polygon given in screen space (even-odd over the given rings).
function fillScreen(rings, color) {
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const ring of rings)
    for (const [, y] of ring) {
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  yMin = Math.max(0, Math.floor(yMin));
  yMax = Math.min(H - 1, Math.ceil(yMax));
  for (let y = yMin; y <= yMax; y++) {
    const cy = y + 0.5;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        if ((y1 <= cy && y2 > cy) || (y2 <= cy && y1 > cy)) xs.push(x1 + ((cy - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(W - 1, Math.floor(xs[k + 1])); x++) setPx(x, y, color);
    }
  }
}

function drawLine(x0, y0, x1, y1, half, color) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  for (let s = 0; s <= steps; s++) {
    const x = x0 + (dx * s) / steps;
    const y = y0 + (dy * s) / steps;
    for (let oy2 = -half; oy2 <= half; oy2++)
      for (let ox2 = -half; ox2 <= half; ox2++)
        if (ox2 * ox2 + oy2 * oy2 <= half * half + 0.5) setPx(Math.round(x + ox2), Math.round(y + oy2), color);
  }
}

// Flat ground layers at Z = 0.
const AREA_STYLE = {
  4: [168, 208, 160], 5: [212, 234, 196], 6: [236, 232, 204], 7: [246, 234, 200], 8: [200, 222, 210],
  9: [236, 228, 220], 10: [224, 218, 228], 11: [242, 222, 216], 12: [230, 224, 240], 13: [196, 232, 204],
  14: [204, 228, 204], 15: [216, 210, 204], 3: [205, 230, 190], 1: [170, 211, 223], 16: [190, 180, 170],
  17: [226, 224, 220],
};
const AREA_ORDER = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 3, 1, 16];
for (const kind of AREA_ORDER) {
  for (const p of map.polygons) {
    if (p.kind !== kind) continue;
    fillScreen(p.rings.map((ring) => ring.map(([la, lo]) => { const [X, Y] = toXY(la, lo); return project(X, Y, 0); })), AREA_STYLE[kind]);
  }
}

const LINE_STYLE = {
  1: [150, 150, 150, 1], 2: [170, 130, 190, 1], 3: [120, 160, 210, 1], 4: [150, 200, 230, 2], 5: [150, 200, 230, 1],
  6: [170, 215, 240, 0], 7: [200, 190, 180, 0], 9: [160, 150, 140, 1], 10: [200, 200, 200, 1], 11: [200, 90, 150, 0],
};
for (const l of map.lines) {
  const s = LINE_STYLE[l.kind];
  if (!s) continue;
  const pts = l.points.map(([la, lo]) => { const [X, Y] = toXY(la, lo); return project(X, Y, 0); });
  for (let i = 0; i < pts.length - 1; i++) drawLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], s[3], [s[0], s[1], s[2]]);
}

const ROAD_STYLE = {
  1: [[233, 120, 120], 2], 2: [[240, 160, 110], 2], 3: [[250, 200, 120], 2], 4: [[250, 225, 150], 1],
  5: [[255, 255, 255], 1], 6: [[255, 255, 255], 1], 7: [[235, 235, 235], 0], 8: [[190, 180, 170], 0],
};
for (const c of [8, 7, 6, 5, 4, 3, 2, 1]) {
  for (const e of map.edges) {
    if (e.roadClass !== c) continue;
    const pts = e.points.map(([la, lo]) => { const [X, Y] = toXY(la, lo); return project(X, Y, 0); });
    for (let i = 0; i < pts.length - 1; i++) drawLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], ROAD_STYLE[c][1], ROAD_STYLE[c][0]);
  }
}

// Buildings: extruded walls and roofs, drawn far to near with back faces culled.
const DEFAULT_HEIGHT = 8; // metres, used when the source gives no height
const DEFAULT_WALL = [200, 186, 172];
const DEFAULT_ROOF = [222, 208, 194];
const LIGHT = [0.6, 0.8]; // ground-plane light direction (from north-east)
const shade = (rgb, f) => rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * f))));

const buildings = [];
for (const p of map.polygons) {
  if (p.kind !== 2) continue;
  const rings = p.rings.map((ring) => ring.map(([la, lo]) => toXY(la, lo)));
  const top = p.height ? p.height / 10 : DEFAULT_HEIGHT;
  const base = p.minHeight ? p.minHeight / 10 : 0;
  const colour = p.colour ? [(p.colour >> 16) & 255, (p.colour >> 8) & 255, p.colour & 255] : null;
  // Depth of the building centre, for far-to-near ordering.
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const ring of rings) for (const [X, Y] of ring) { sx += X; sy += Y; n++; }
  const cy = n ? sy / n : 0;
  buildings.push({ rings, top, base, colour, depth: cosT * (cy - Cy) - sinT * (0 - Cz) });
}
buildings.sort((a, b) => b.depth - a.depth);

let drawnWalls = 0;
for (const b of buildings) {
  const wall = b.colour ?? DEFAULT_WALL;
  const roof = b.colour ? shade(b.colour, 1.08) : DEFAULT_ROOF;
  for (const ring of b.rings) {
    if (ring.length < 3) continue;
    // Signed area: positive means counter-clockwise, so the outward normal is (dy, -dx).
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      area += x1 * y2 - x2 * y1;
    }
    const orient = area >= 0 ? 1 : -1;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      const nx = (orient * dy) / len;
      const ny = (orient * -dx) / len;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      // Back-face cull: the wall faces away from the camera when its normal points away.
      if (nx * (0 - mx) + ny * (Cy - my) <= 0) continue;
      const f = 0.72 + 0.28 * Math.abs(nx * LIGHT[0] + ny * LIGHT[1]);
      const quad = [
        project(x1, y1, b.base),
        project(x2, y2, b.base),
        project(x2, y2, b.top),
        project(x1, y1, b.top),
      ];
      fillScreen([quad], shade(wall, f));
      drawnWalls++;
    }
  }
  // Roof: the outer rings at the top height.
  fillScreen(b.rings.map((ring) => ring.map(([X, Y]) => project(X, Y, b.top))), roof);
}

await writeFile(outFile, encodePng(img, W, H));
console.log(`wrote ${outFile} ${W}x${H} buildings ${buildings.length} walls ${drawnWalls} tilt ${tiltDeg}`);
