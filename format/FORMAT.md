# Drivemate map file format (DMAP), version 1

Our own binary format for one downloadable map area. All numbers are little-endian.
Coordinates are stored as signed 32-bit integers in units of 1e-7 degree
(about 1.1 cm). Latitude and longitude are both stored, in that order.

The app's Kotlin reader must follow this document exactly. The JavaScript
reference reader is `tools/dmap.mjs`.

## Header (fixed, 40 bytes)

| Offset | Type      | Field        | Meaning                              |
|--------|-----------|--------------|--------------------------------------|
| 0      | 4 bytes   | magic        | ASCII `DMAP`                         |
| 4      | u16       | version      | `1`                                  |
| 6      | u16       | reserved     | `0`                                  |
| 8      | i32 x 4   | bbox         | minLat, minLon, maxLat, maxLon       |
| 24     | u32       | nodeCount    | number of road nodes                 |
| 28     | u32       | edgeCount    | number of road edges                 |
| 32     | u32       | polygonCount | number of area features              |
| 36     | u32       | labelCount   | number of named places               |

## Nodes (nodeCount records, 8 bytes each)

| Type | Field |
|------|-------|
| i32  | lat   |
| i32  | lon   |

Nodes are road junctions and road ends. Two road ends closer than about 2 m
share one node. Node IDs are the record index (0-based).

## Edges (edgeCount records)

| Type      | Field       | Meaning |
|-----------|-------------|---------|
| u32       | fromNode    | node ID the edge starts at |
| u32       | toNode      | node ID the edge ends at |
| u8        | roadClass   | see road classes below |
| u8        | flags       | see edge flags below |
| u16       | pointCount  | number of points, at least 2 |
| i32 x 2 x pointCount | points | lat, lon pairs in travel order; first point = fromNode, last point = toNode |

Road classes: 1 motorway, 2 trunk, 3 primary, 4 secondary, 5 tertiary,
6 minor (residential and unclassified), 7 service, 8 track.

Edge flags (bit set = true):

| Bit | Meaning |
|-----|---------|
| 0   | one-way: travel is allowed only from fromNode to toNode. If clear, travel is allowed both ways. |
| 1   | bridge |
| 2   | tunnel |
| 3   | toll |
| 4   | no motor access (access tag `no` or `private`). Drawn, never routed. |

## Polygons (polygonCount records)

| Type | Field      | Meaning |
|------|------------|---------|
| u8   | kind       | 1 water, 2 building, 3 park |
| u16  | ringCount  | number of rings in the feature |
| per ring: u32 pointCount, then pointCount x (i32 lat, i32 lon) | rings | closed rings |

Draw with the even-odd fill rule so holes are cut out.

## Labels (labelCount records)

| Type | Field    | Meaning |
|------|----------|---------|
| u8   | kind     | 1 city, 2 town, 3 village, 4 suburb, 5 other place |
| i32  | lat      | |
| i32  | lon      | |
| u8   | nameLen  | byte length of the name, at most 255 |
| bytes | name    | UTF-8 name |

## Source and licence

Source data: OpenStreetMap, through OpenFreeMap's vector tiles (OpenMapTiles
schema). Required attribution: "© OpenStreetMap contributors" (ODbL). The
app must show this attribution.
