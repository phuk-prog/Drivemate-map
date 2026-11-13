// Fixed grid of map squares. The world is split into squares 0.05 degrees on each side.
// A square is identified by its integer indices: latIdx = floor(lat * 20), lonIdx = floor(lon * 20).
// Our own code. Used by the builder and by the app (the app has its own copy in Kotlin).

export const SQUARES_PER_DEGREE = 20;

export function squareIndex(latDeg, lonDeg) {
  return { latIdx: Math.floor(latDeg * SQUARES_PER_DEGREE), lonIdx: Math.floor(lonDeg * SQUARES_PER_DEGREE) };
}

export function squareId({ latIdx, lonIdx }) {
  return `lat${latIdx}_lon${lonIdx}`;
}

// Bounding box of a square: [minLat, minLon, maxLat, maxLon] in degrees.
export function squareBbox({ latIdx, lonIdx }) {
  return [latIdx / SQUARES_PER_DEGREE, lonIdx / SQUARES_PER_DEGREE, (latIdx + 1) / SQUARES_PER_DEGREE, (lonIdx + 1) / SQUARES_PER_DEGREE];
}

// Every square a bounding box touches.
export function squaresTouching([minLat, minLon, maxLat, maxLon]) {
  const a = squareIndex(minLat, minLon);
  const b = squareIndex(maxLat, maxLon);
  const out = [];
  for (let latIdx = a.latIdx; latIdx <= b.latIdx; latIdx++) {
    for (let lonIdx = a.lonIdx; lonIdx <= b.lonIdx; lonIdx++) out.push({ latIdx, lonIdx });
  }
  return out;
}

// The square named by an id such as "lat1068_lon-44", or null.
export function parseSquareId(id) {
  const m = /^lat(-?\d+)_lon(-?\d+)$/.exec(id);
  return m ? { latIdx: Number(m[1]), lonIdx: Number(m[2]) } : null;
}

// Square files are published as GitHub release assets, one release per latitude row,
// because a release holds at most 1000 files. The app builds the same URL from the square id.
export const SQUARES_REPO = "phuk-prog/Drivemate-map";

export function squareRelease({ latIdx }) {
  return `squares-lat${latIdx}`;
}

export function squareUrl(sq, repo = SQUARES_REPO) {
  return `https://github.com/${repo}/releases/download/${squareRelease(sq)}/${squareId(sq)}.dmap.gz`;
}
