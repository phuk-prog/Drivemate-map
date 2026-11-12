# Drivemate map file format (DMAP), version 4

Our own binary format for one downloadable map area. All numbers are little-endian.
Coordinates are stored as signed 32-bit integers in units of 1e-7 degree
(about 1.1 cm). Latitude and longitude are both stored, in that order.

The app's Kotlin reader must follow this document exactly. The JavaScript
reference reader is `tools/dmap.mjs`. Class-to-code tables are in `tools/classes.mjs`.

Readers must also accept version 3 files. Version 3 has a 44-byte header (no
stringCount or restrictionCount), no strings or restrictions sections, and edges
without the version 4 fields marked "(v4)" below.

## Header (fixed, 52 bytes)

| Offset | Type      | Field            | Meaning                              |
|--------|-----------|------------------|--------------------------------------|
| 0      | 4 bytes   | magic            | ASCII `DMAP`                         |
| 4      | u16       | version          | `4`                                  |
| 6      | u16       | reserved         | `0`                                  |
| 8      | i32 x 4   | bbox             | minLat, minLon, maxLat, maxLon       |
| 24     | u32       | nodeCount        | number of road nodes                 |
| 28     | u32       | edgeCount        | number of routable road edges        |
| 32     | u32       | lineCount        | number of non-routed lines           |
| 36     | u32       | polygonCount     | number of area features              |
| 40     | u32       | labelCount       | number of names and places           |
| 44     | u32       | stringCount      | number of strings (v4)               |
| 48     | u32       | restrictionCount | number of turn restrictions (v4)     |

Sections follow in this order: strings, nodes, edges, lines, polygons, labels, restrictions.

## Strings (stringCount records) (v4)

| Type  | Field  | Meaning |
|-------|--------|---------|
| u16   | length | byte length of the string |
| bytes | text   | UTF-8 text |

Strings are referred to by index (0-based). String 0 is always the empty string and
means "none". Street names, road numbers and turn lanes are stored here once each.

## Nodes (nodeCount records, 8 bytes each)

| Type | Field |
|------|-------|
| i32  | lat   |
| i32  | lon   |

Nodes are road junctions and road ends. With roads from OpenStreetMap, a junction is
a point shared by two or more roads. With roads from the tiles, two road ends closer
than about 2 m share one node. Node IDs are the record index (0-based).

## Edges (edgeCount records): routable roads

| Type      | Field        | Meaning |
|-----------|--------------|---------|
| u32       | fromNode     | node ID the edge starts at |
| u32       | toNode       | node ID the edge ends at |
| u8        | roadClass    | see road classes below |
| u8        | flags        | see edge flags below |
| u8        | maxspeed     | (v4) speed limit in km/h, 0 when unknown |
| u8        | lanes        | (v4) number of lanes, 0 when unknown |
| u32       | name         | (v4) string index of the street name, 0 for none |
| u32       | ref          | (v4) string index of the road number (for example "A6"), 0 for none |
| u32       | turnLanesFwd | (v4) string index of the turn lanes when travelling fromNode to toNode, 0 for none |
| u32       | turnLanesBwd | (v4) string index of the turn lanes when travelling toNode to fromNode, 0 for none |
| u16       | pointCount   | number of points, at least 2 |
| i32 x 2 x pointCount | points | lat, lon pairs in travel order; first point = fromNode, last point = toNode |

Road classes: 1 motorway, 2 trunk, 3 primary, 4 secondary, 5 tertiary,
6 minor (residential and unclassified), 7 service, 8 track.

Turn lanes use the OpenStreetMap form: lanes from left to right separated by `|`,
and several directions in one lane separated by `;`, for example `left|through;right|right`.

Edge flags (bit set = true):

| Bit | Meaning |
|-----|---------|
| 0   | one-way: travel is allowed only from fromNode to toNode. If clear, travel is allowed both ways. |
| 1   | bridge |
| 2   | tunnel |
| 3   | toll |
| 4   | no motor access (access tag `no` or `private`). Drawn, never routed. |
| 5   | roundabout (v4) |

## Lines (lineCount records): drawn, not routed

| Type | Field      | Meaning |
|------|------------|---------|
| u8   | kind       | see line kinds below |
| u8   | level      | boundaries: admin level (2 country, 4 region, 6 county, 8 borough, and others). Otherwise 0. |
| u32  | pointCount | number of points, at least 2 |
| i32 x 2 x pointCount | points | lat, lon pairs |

Line kinds: 1 rail, 2 Underground and other transit, 3 ferry, 4 river,
5 canal, 6 stream, drain or ditch, 7 footpath, bridleway or cycleway,
9 pier, 10 airport taxiway or runway, 11 administrative boundary.

## Polygons (polygonCount records)

| Type | Field      | Meaning |
|------|------------|---------|
| u8   | kind       | see polygon kinds below |
| u16  | height     | building height in decimetres (metres x 10). 0 = unknown. Other kinds: 0. |
| u16  | minHeight  | building base height in decimetres (for parts raised above ground). 0 = ground. |
| u24  | colour     | RGB, three bytes (red, green, blue). 0 = no colour given. |
| u16  | ringCount  | number of rings in the feature |
| per ring: u32 pointCount, then pointCount x (i32 lat, i32 lon) | rings | closed rings |

Draw with the even-odd fill rule so holes are cut out.

Polygon kinds: 1 water, 2 building, 3 park or nature reserve, 4 wood,
5 grass and green space, 6 farmland or orchard, 7 sand or beach, 8 wetland,
9 residential land, 10 industrial, 11 commercial or retail,
12 institutional (school, hospital, university, library), 13 sports and recreation,
14 cemetery, 15 rock or quarry, 16 pier, 17 airport apron, runway area or helipad.

Land use is only as complete as the source. Many suburban areas have no land-use
polygon, so they are blank in the file.

## Labels (labelCount records)

| Type  | Field    | Meaning |
|-------|----------|---------|
| u8    | kind     | 1 place, 2 road name, 3 water name, 4 park name, 5 point of interest, 6 house number, 7 speed camera |
| u8    | category | depends on kind (below) |
| i32   | lat      | anchor point |
| i32   | lon      | anchor point |
| u8    | nameLen  | byte length of the name, at most 255 |
| bytes | name     | UTF-8 name |

Categories:
- place: 1 city, 2 town, 3 village, 4 hamlet, 5 suburb, 6 quarter, 7 neighbourhood, 8 isolated dwelling, 9 island.
- road name: road class 1 to 8 as above, 9 footpath or cycleway, 0 unknown.
- water name: 1 lake or water body, 2 bay.
- park name: 0.
- point of interest: 1 food and drink, 2 shops, 3 transport, 4 health, 5 education,
  6 parking and fuel, 7 lodging, 8 place of worship, 9 leisure and culture,
  10 public services, 11 other.
- house number: 0.
- speed camera: the speed limit the camera enforces, in km/h (at most 255). 0 = unknown.

Speed camera labels (kind 7) are fixed speed cameras from OpenStreetMap: nodes tagged
`highway=speed_camera`, and the device nodes of `type=enforcement` relations with
`enforcement=maxspeed`. They are present only when the roads come from an OpenStreetMap
extract. The anchor point is the camera. The name is not a name: it is the camera's
OpenStreetMap `direction` tag, in whole degrees clockwise from north (0 to 359) written as
decimal text, for example `270`. An empty name means the direction is unknown or was not
given as a number. There are no live hazards
in the file; OpenStreetMap has no reliable source for them.

Only named features produce labels, apart from speed cameras. Labels are drawn by the app, not stored as images.

## Restrictions (restrictionCount records) (v4)

| Type | Field    | Meaning |
|------|----------|---------|
| u32  | fromEdge | edge the turn starts on |
| u32  | viaNode  | junction node where the turn happens |
| u32  | toEdge   | edge the turn leads onto |
| u8   | kind     | 1 no turn: never go fromEdge, viaNode, toEdge. 2 only turn: from fromEdge at viaNode, toEdge is the only allowed exit |

Restrictions come from OpenStreetMap turn restriction relations whose "via" is a node.
Restrictions whose "via" is a road are not stored yet.

## Source and licence

Source data: OpenStreetMap, through OpenFreeMap's vector tiles (OpenMapTiles
schema). Required attribution: "© OpenStreetMap contributors" (ODbL). The
app must show this attribution.
