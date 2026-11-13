// Finds the download URL of a Geofabrik OpenStreetMap extract by its id, using Geofabrik's
// own index, so nobody has to guess the path. Build-time only.
// Usage: node tools/geofabrik-url.mjs greater-london
// Prints the .osm.pbf URL. If the id is not found, prints the closest ids and exits with code 1.

const INDEX_URL = "https://download.geofabrik.de/index-v1-nogeom.json";

const wanted = process.argv[2];
if (!wanted) {
  console.error("usage: node tools/geofabrik-url.mjs <extract id, for example greater-london>");
  process.exit(1);
}

// GitHub's runners sometimes cannot connect to Geofabrik for a moment (ECONNREFUSED seen once),
// so try up to 6 times with a growing pause.
let features = null;
let lastError = "";
for (let attempt = 1; attempt <= 6 && !features; attempt++) {
  try {
    const res = await fetch(INDEX_URL);
    if (res.ok) features = (await res.json()).features || [];
    else lastError = `HTTP ${res.status}`;
  } catch (err) {
    lastError = err.cause && err.cause.code ? err.cause.code : err.message;
  }
  if (!features && attempt < 6) {
    console.error(`Geofabrik index attempt ${attempt} failed (${lastError}); retrying`);
    await new Promise((r) => setTimeout(r, attempt * 5000));
  }
}
if (!features) {
  console.error(`Could not read the Geofabrik index: ${lastError}`);
  process.exit(1);
}
const hit = features.find((f) => f.properties && f.properties.id === wanted);
if (hit && hit.properties.urls && hit.properties.urls.pbf) {
  console.log(hit.properties.urls.pbf);
} else {
  const close = features
    .map((f) => f.properties)
    .filter((p) => p && (p.id.includes(wanted) || (p.name || "").toLowerCase().includes(wanted.split("-").pop())))
    .slice(0, 15)
    .map((p) => `${p.id} (${p.name})`);
  console.error(`No extract with id "${wanted}". Close matches: ${close.join(", ") || "none"}`);
  process.exit(1);
}
