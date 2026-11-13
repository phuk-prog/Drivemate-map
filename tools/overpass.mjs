// Shared Overpass API request, with retries and back-off on busy (429) responses.
// Build-time only: the app never calls Overpass. Our own code.

export const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Overpass bounding boxes are (south, west, north, east). Our bboxes are (west, south, east, north).
export function overpassBox([minLon, minLat, maxLon, maxLat]) {
  return `(${minLat},${minLon},${maxLat},${maxLon})`;
}

export async function fetchOverpass(query) {
  let lastError = null;
  for (const url of ENDPOINTS) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: query }),
        });
        if (res.status === 429) {
          // Overpass is busy. Wait longer before trying again.
          lastError = new Error(`HTTP 429 from ${url}`);
          await new Promise((r) => setTimeout(r, 60000 * attempt));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
  }
  throw new Error(`Overpass request failed: ${lastError?.message}`);
}
