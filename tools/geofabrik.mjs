// Finds the download link of a Geofabrik extract from Geofabrik's own index, by extract id
// (for example "greater-manchester"), so links stay right if Geofabrik moves files.
const INDEX = "https://download.geofabrik.de/index-v1-nogeom.json";

export async function extractUrl(id) {
  const res = await fetch(INDEX);
  if (!res.ok) throw new Error(`Geofabrik index: HTTP ${res.status}`);
  const index = await res.json();
  const hit = index.features.find((f) => f.properties.id === id);
  if (!hit) throw new Error(`Geofabrik has no extract with id "${id}"`);
  return hit.properties.urls.pbf;
}
