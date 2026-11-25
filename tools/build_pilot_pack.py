#!/usr/bin/env python3
"""Build the detailed Wells pilot map pack (PMTiles v3, MVT) from the pinned OSM extract.

Standard library only, deterministic (same input bytes -> same output bytes).

Input:  osm/wells-places-2026-11-19.osm (Overpass extract with provenance and
        a MANIFEST.json SHA-256). It holds highways, named places and some
        buildings for the Wells pilot bbox. It holds no water or land cover, so
        the pack draws none: nothing is invented to fill the gaps.
Output: pilot/wells-z12-16.pmtiles plus a .sha256 line.

Layers (names follow the overview pack where they overlap):
  roads      LineString  kind=<highway value>, name, ref (when tagged)
  buildings  Polygon     kind=building
  places     Point       kind=<amenity/shop/tourism/...>, name

Map data (c) OpenStreetMap contributors, ODbL 1.0. NOT FOR DRIVING.

    python3 tools/build_pilot_pack.py           # build and write
    python3 tools/build_pilot_pack.py --check   # rebuild in memory, compare with the committed pack
"""
import gzip
import hashlib
import io
import json
import math
import os
import struct
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = "osm/wells-places-2026-11-19.osm"
SOURCE_SHA256 = "8cde16000a69096b62f7a75598fb892c2d8eea34b8f2237278a785ddf125ce26"
OUTPUT = "pilot/wells-z12-16.pmtiles"
# Pilot bbox from requests/wells-places.json: lat_min, lon_min, lat_max, lon_max.
BBOX = (51.198, -2.668, 51.222, -2.622)
MIN_ZOOM, MAX_ZOOM = 12, 16
EXTENT = 4096
BUFFER = 64  # tile units outside the tile edge that still count as "in" the tile
ATTRIBUTION = "(c) OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright"
ROAD_KINDS = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
    "living_street", "service", "motorway_link", "trunk_link", "primary_link",
    "secondary_link", "tertiary_link",
}
PLACE_KEYS = ("amenity", "shop", "tourism", "leisure", "historic", "office")


# ---------- projection ----------
def unit_x(lon):
    return (lon + 180.0) / 360.0


def unit_y(lat):
    s = math.sin(math.radians(lat))
    return 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)


# ---------- OSM parsing ----------
def load_features(path):
    root = ET.parse(path).getroot()
    nodes = {}
    for n in root.iter("node"):
        nodes[n.get("id")] = (float(n.get("lon")), float(n.get("lat")))
    feats = []  # (layer, geom_type, [[(ux,uy),...]], props, osm_id)
    for n in root.iter("node"):
        tags = {t.get("k"): t.get("v") for t in n.iter("tag")}
        kind = next((tags[k] for k in PLACE_KEYS if k in tags), None)
        if kind and tags.get("name"):
            lon, lat = nodes[n.get("id")]
            feats.append(("places", 1, [[(unit_x(lon), unit_y(lat))]],
                          {"kind": kind, "name": tags["name"]}, int(n.get("id")) * 2))
    for w in root.iter("way"):
        tags = {t.get("k"): t.get("v") for t in w.iter("tag")}
        refs = [nd.get("ref") for nd in w.iter("nd")]
        pts = [nodes[r] for r in refs if r in nodes]
        if len(pts) != len(refs) or len(pts) < 2:
            continue  # incomplete way: dropped, never patched
        ring = [(unit_x(lon), unit_y(lat)) for lon, lat in pts]
        wid = int(w.get("id")) * 2 + 1
        hw = tags.get("highway")
        if hw in ROAD_KINDS:
            props = {"kind": hw}
            for k in ("name", "ref"):
                if tags.get(k):
                    props[k] = tags[k]
            feats.append(("roads", 2, [ring], props, wid))
        elif "building" in tags and refs[0] == refs[-1] and len(ring) >= 4:
            feats.append(("buildings", 3, [ring], {"kind": "building"}, wid))
        kind = next((tags[k] for k in PLACE_KEYS if k in tags), None)
        if kind and tags.get("name") and hw is None:
            cx = sum(p[0] for p in ring) / len(ring)
            cy = sum(p[1] for p in ring) / len(ring)
            feats.append(("places", 1, [[(cx, cy)]], {"kind": kind, "name": tags["name"]}, wid))
    feats.sort(key=lambda f: (f[0], f[4]))
    return feats


# ---------- protobuf / MVT encoding ----------
def varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def zigzag(v):
    return (v << 1) ^ (v >> 31)


def field_bytes(num, payload):
    return varint((num << 3) | 2) + varint(len(payload)) + payload


def field_varint(num, v):
    return varint(num << 3) + varint(v)


def packed(num, values):
    return field_bytes(num, b"".join(varint(v) for v in values))


def command(cmd, count):
    return (count << 3) | cmd


def encode_geometry(gtype, parts):
    out, cx, cy = [], 0, 0
    for part in parts:
        pts = part
        if gtype == 3 and len(pts) > 1 and pts[0] == pts[-1]:
            pts = pts[:-1]
        for i, (x, y) in enumerate(pts):
            dx, dy = x - cx, y - cy
            cx, cy = x, y
            if i == 0:
                out += [command(1, 1), zigzag(dx), zigzag(dy)]
                if gtype != 1 and len(pts) > 1:
                    out.append(command(2, len(pts) - 1))
            else:
                out += [zigzag(dx), zigzag(dy)]
        if gtype == 3:
            out.append(command(7, 1))
    return out


def tile_points(ring, z, x, y):
    n = 1 << z
    pts = []
    for ux, uy in ring:
        px = int(round((ux * n - x) * EXTENT))
        py = int(round((uy * n - y) * EXTENT))
        if not pts or pts[-1] != (px, py):
            pts.append((px, py))
    return pts


def encode_layer(name, feats, z, x, y):
    keys, values, kidx, vidx = [], [], {}, {}
    body = []
    for _, gtype, parts, props, fid in feats:
        tparts = [tile_points(p, z, x, y) for p in parts]
        if gtype == 2 and any(len(p) < 2 for p in tparts):
            continue
        if gtype == 3 and any(len(p) < 4 for p in tparts):
            continue
        tags = []
        for k in sorted(props):
            v = props[k]
            if k not in kidx:
                kidx[k] = len(keys)
                keys.append(k)
            if v not in vidx:
                vidx[v] = len(values)
                values.append(v)
            tags += [kidx[k], vidx[v]]
        f = field_varint(1, fid) + packed(2, tags) + field_varint(3, gtype) + packed(4, encode_geometry(gtype, tparts))
        body.append(field_bytes(2, f))
    if not body:
        return b""
    out = field_varint(15, 2) + field_bytes(1, name.encode())
    out += b"".join(body)
    out += b"".join(field_bytes(3, k.encode()) for k in keys)
    out += b"".join(field_bytes(4, field_bytes(1, v.encode())) for v in values)
    out += field_varint(5, EXTENT)
    return field_bytes(3, out)


def bbox_of(parts):
    xs = [p[0] for part in parts for p in part]
    ys = [p[1] for part in parts for p in part]
    return min(xs), min(ys), max(xs), max(ys)


def build_tiles(feats):
    tiles = {}
    boxes = [bbox_of(f[2]) for f in feats]
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        n = 1 << z
        x0, x1 = int(unit_x(BBOX[1]) * n), int(unit_x(BBOX[3]) * n)
        y0, y1 = int(unit_y(BBOX[2]) * n), int(unit_y(BBOX[0]) * n)
        pad = BUFFER / EXTENT / n
        for ty in range(y0, y1 + 1):
            for tx in range(x0, x1 + 1):
                lo_x, lo_y = tx / n - pad, ty / n - pad
                hi_x, hi_y = (tx + 1) / n + pad, (ty + 1) / n + pad
                layers = {}
                for f, (a, b, c, d) in zip(feats, boxes):
                    if c < lo_x or a > hi_x or d < lo_y or b > hi_y:
                        continue
                    if f[0] == "places" and not (lo_x + pad <= a < hi_x - pad and lo_y + pad <= b < hi_y - pad):
                        continue  # a point belongs to exactly one tile, so labels are not repeated
                    if f[0] == "buildings" and z < 14:
                        continue
                    layers.setdefault(f[0], []).append(f)
                data = b"".join(encode_layer(name, layers[name], z, tx, ty) for name in sorted(layers))
                if data:
                    tiles[tile_id(z, tx, ty)] = data
    return tiles


# ---------- PMTiles v3 ----------
def tile_id(z, x, y):
    acc = ((1 << (2 * z)) - 1) // 3
    n = 1 << z
    d, xx, yy = 0, x, y
    s = n // 2
    while s > 0:
        rx = 1 if xx & s else 0
        ry = 1 if yy & s else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                xx, yy = n - 1 - xx, n - 1 - yy
            xx, yy = yy, xx
        s //= 2
    return acc + d


def gz(data):
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0, compresslevel=9) as g:
        g.write(data)
    return buf.getvalue()


def build_pack(source_path):
    feats = load_features(source_path)
    tiles = build_tiles(feats)
    ids = sorted(tiles)
    blobs, entries, offset = [], [], 0
    for tid in ids:
        blob = gz(tiles[tid])
        entries.append((tid, offset, len(blob)))
        blobs.append(blob)
        offset += len(blob)
    directory = varint(len(entries))
    last = 0
    for tid, _, _ in entries:
        directory += varint(tid - last)
        last = tid
    directory += b"".join(varint(1) for _ in entries)
    directory += b"".join(varint(length) for _, _, length in entries)
    directory += b"".join(varint(off + 1) for _, off, _ in entries)
    root = gz(directory)
    counts = {}
    for f in feats:
        counts[f[0]] = counts.get(f[0], 0) + 1
    metadata = gz(json.dumps({
        "name": "wells-pilot",
        "description": "Detailed offline pilot pack for Wells, Somerset. Roads, road names, named places "
                       "and tagged buildings only; no water or land cover in the source. NOT FOR DRIVING.",
        "attribution": ATTRIBUTION,
        "licence": "ODbL-1.0",
        "source": {"path": SOURCE, "sha256": SOURCE_SHA256, "osm_base": "2026-11-19T22:15:10Z"},
        "bbox": {"lat_min": BBOX[0], "lon_min": BBOX[1], "lat_max": BBOX[2], "lon_max": BBOX[3]},
        "feature_counts": counts,
        "vector_layers": [{"id": n, "minzoom": 14 if n == "buildings" else MIN_ZOOM, "maxzoom": MAX_ZOOM}
                          for n in ("buildings", "places", "roads")],
    }, sort_keys=True, separators=(",", ":")).encode())
    data = b"".join(blobs)
    root_off = 127
    meta_off = root_off + len(root)
    leaf_off = meta_off + len(metadata)
    data_off = leaf_off
    header = bytearray(127)
    header[0:7] = b"PMTiles"
    header[7] = 3
    struct.pack_into("<QQQQQQQQ", header, 8, root_off, len(root), meta_off, len(metadata),
                     leaf_off, 0, data_off, len(data))
    struct.pack_into("<QQQ", header, 72, len(entries), len(entries), len(entries))
    header[96] = 1  # clustered
    header[97] = 2  # gzip directories
    header[98] = 2  # gzip tiles
    header[99] = 1  # MVT
    header[100] = MIN_ZOOM
    header[101] = MAX_ZOOM
    e7 = lambda v: int(round(v * 1e7))
    struct.pack_into("<iiii", header, 102, e7(BBOX[1]), e7(BBOX[0]), e7(BBOX[3]), e7(BBOX[2]))
    header[118] = 14
    struct.pack_into("<ii", header, 119, e7((BBOX[1] + BBOX[3]) / 2), e7((BBOX[0] + BBOX[2]) / 2))
    return bytes(header) + root + metadata + data, counts, len(entries)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv):
    global MAX_ZOOM, OUTPUT
    # Opt-in bounded experiment; the committed z12-16 pack remains byte-identical.
    if "--detail-z18" in argv:
        MAX_ZOOM = 18
        OUTPUT = "pilot/wells-z12-18-experimental.pmtiles"
    if any(a not in ("--detail-z18", "--check") for a in argv):
        print("unsupported option", file=sys.stderr)
        return 2
    src = os.path.join(ROOT, SOURCE)
    if sha256_file(src) != SOURCE_SHA256:
        print("source extract SHA-256 mismatch; refusing to build", file=sys.stderr)
        return 1
    pack, counts, n = build_pack(src)
    digest = hashlib.sha256(pack).hexdigest()
    out = os.path.join(ROOT, OUTPUT)
    if "--check" in argv:
        if not os.path.isfile(out) or sha256_file(out) != digest:
            print("committed pilot pack does not match a fresh build", file=sys.stderr)
            return 1
        print(f"pilot pack reproducible: {digest} ({len(pack)} bytes, {n} tiles)")
        return 0
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(pack)
    with open(out + ".sha256", "w") as f:
        f.write(f"{digest}  {os.path.basename(OUTPUT)}\n")
    print(f"wrote {OUTPUT}: {len(pack)} bytes, {n} tiles, sha256 {digest}, features {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
