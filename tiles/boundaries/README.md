# UK clipping polygons — pinned map-data inputs

These four small `.poly` files are source map-data assets, not application code.

Copied verbatim from Geofabrik's public clipping-polygon repository on
20 November 2026:

https://github.com/geofabrik/polygons_download.geofabrik.de

| Stored file | Source path | Upstream Git blob SHA |
|---|---|---|
| `england.poly` | `polygons/europe/united-kingdom/england.poly` | `5a2fa7dae4a2c9005e51aa08b29323c897ebdba6` |
| `scotland.poly` | `polygons/europe/united-kingdom/scotland.poly` | `cf14821f73d61d498c91c89d93f48e229c6ae934` |
| `wales.poly` | `polygons/europe/united-kingdom/wales.poly` | `66d9b61f0d2db3ad4c0e2cd78f3d071cea3b0327` |
| `united-kingdom.poly` | `polygons/europe/united-kingdom.poly` | `c1a3d33bf14a301be6ae5f5e8ae048c0364874de` |

**Licence:** Geofabrik publishes its clipping polygons as OpenStreetMap
*Produced Works* under ODbL 1.0, with required attribution:
© OpenStreetMap contributors, https://www.openstreetmap.org/copyright.

Why bundled? The Geofabrik download-server endpoints for the England
boundary returned HTTP 404 to GitHub Actions on 20 November 2026,
even when the directory index advertised the files. These official
source polygons are small enough to store, review and version in Git.
The nightly *map data* still uses the fresh full UK Geofabrik extract.

**Geographic caveat:** Original source clipping polygons may extend
slightly beyond the precise extract region. Geofabrik creates its
published extract polygons by intersecting these with parent polygons.
This is safe for clipping a UK-limited tile archive, although border
buffers may overlap. Never call these polygons authoritative political
boundaries. For future boundary revisions, update from the official
Geofabrik repository as a separately reviewed, integrity-tested change.

The preflight checks all polygons for valid geometry and reference
city coverage before any expensive Planetiler processing.
