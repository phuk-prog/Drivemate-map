#!/usr/bin/env python3
"""Build, sign and verify the Drivemate offline tile catalog (stdlib + cryptography).

The tile workflow (.github/workflows/build-tiles.yml) produces PMTiles v3
archives and publishes them as GitHub Release assets. This tool:

* ``poly2geojson``  converts an Osmosis/Geofabrik ``.poly`` file to GeoJSON
  (``pmtiles extract --region`` takes GeoJSON);
* ``inspect``       reads a PMTiles v3 header and metadata (bounds, zooms, tile
  type, vector layers) without any third-party library;
* ``build``         writes ``catalog.json``: one entry per archive with name,
  bounds, zoom range, byte size, SHA-256, data timestamp, licence and
  attribution. It refuses archives that are not MVT, that reach the GitHub
  2 GiB per-asset limit, or whose layers carry OSM contributor identity;
* ``sign``          writes a detached Ed25519 signature of the exact catalog
  bytes. The key is a TEST-ONLY key, NOT FOR PRODUCTION (production key
  custody is a release gate). Without a key the catalog is marked UNSIGNED;
* ``verify``        checks a detached signature against a public key.

Map data is (c) OpenStreetMap contributors, ODbL 1.0.
"""
import argparse
import base64
import gzip
import hashlib
import json
import os
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

ASSET_LIMIT = 2 * 1024 ** 3          # GitHub release asset limit: 2 GiB
TEST_KEY_WARNING = "TEST-ONLY SIGNING KEY - NOT FOR PRODUCTION. Production key custody is an M6 release gate."
UNSIGNED = "UNSIGNED"
FORBIDDEN_FIELDS = {"user", "uid", "changeset", "osm_user", "osm_uid", "osm_changeset"}
TILE_TYPES = {0: "unknown", 1: "mvt", 2: "png", 3: "jpeg", 4: "webp", 5: "avif"}
COMPRESSION = {0: "unknown", 1: "none", 2: "gzip", 3: "brotli", 4: "zstd"}
HEADER_LEN = 127


# --------------------------------------------------------------------- .poly
def parse_poly(text):
    """Return a GeoJSON MultiPolygon geometry from Osmosis .poly text.

    Sections whose name starts with '!' are holes of the preceding ring.
    """
    lines = [l.strip() for l in text.splitlines()]
    lines = [l for l in lines if l]
    if not lines:
        raise ValueError("empty poly file")
    i = 1                       # first line is the file name
    polygons = []
    while i < len(lines):
        name = lines[i]
        if name == "END":
            break
        i += 1
        ring = []
        while i < len(lines) and lines[i] != "END":
            parts = lines[i].split()
            ring.append([float(parts[0]), float(parts[1])])
            i += 1
        if i >= len(lines):
            raise ValueError("unterminated poly section " + name)
        i += 1                  # skip section END
        if len(ring) < 3:
            raise ValueError("poly section %s has fewer than 3 points" % name)
        if ring[0] != ring[-1]:
            ring.append(list(ring[0]))
        if name.startswith("!"):
            if not polygons:
                raise ValueError("hole before any outer ring")
            polygons[-1].append(ring)
        else:
            polygons.append([ring])
    if not polygons:
        raise ValueError("poly file has no rings")
    return {"type": "MultiPolygon", "coordinates": polygons}


def geometry_bounds(geom):
    xs, ys = [], []
    for poly in geom["coordinates"]:
        for ring in poly:
            for x, y in ring:
                xs.append(x)
                ys.append(y)
    return [min(xs), min(ys), max(xs), max(ys)]


# ------------------------------------------------------------------ PMTiles
def read_header(path):
    with open(path, "rb") as f:
        raw = f.read(HEADER_LEN)
    return parse_header(raw)


def parse_header(raw):
    if len(raw) < HEADER_LEN or raw[:7] != b"PMTiles":
        raise ValueError("not a PMTiles archive")
    if raw[7] != 3:
        raise ValueError("unsupported PMTiles version %d (need 3)" % raw[7])
    u64 = struct.unpack_from("<11Q", raw, 8)
    keys = ("root_dir_offset", "root_dir_length", "metadata_offset", "metadata_length",
            "leaf_dirs_offset", "leaf_dirs_length", "tile_data_offset", "tile_data_length",
            "addressed_tiles", "tile_entries", "tile_contents")
    h = dict(zip(keys, u64))
    clustered, icomp, tcomp, ttype, minz, maxz = struct.unpack_from("<6B", raw, 96)
    min_lon, min_lat, max_lon, max_lat = struct.unpack_from("<4i", raw, 102)
    cz = raw[118]
    c_lon, c_lat = struct.unpack_from("<2i", raw, 119)
    h.update({
        "version": 3, "clustered": bool(clustered),
        "internal_compression": COMPRESSION.get(icomp, str(icomp)),
        "tile_compression": COMPRESSION.get(tcomp, str(tcomp)),
        "tile_type": TILE_TYPES.get(ttype, str(ttype)),
        "min_zoom": minz, "max_zoom": maxz,
        "bounds": [min_lon / 1e7, min_lat / 1e7, max_lon / 1e7, max_lat / 1e7],
        "center": [c_lon / 1e7, c_lat / 1e7, cz],
    })
    return h


def read_metadata(path, header=None):
    header = header or read_header(path)
    with open(path, "rb") as f:
        f.seek(header["metadata_offset"])
        raw = f.read(header["metadata_length"])
    comp = header["internal_compression"]
    if comp == "gzip":
        raw = gzip.decompress(raw)
    elif comp not in ("none", "unknown"):
        raise ValueError("unsupported metadata compression " + comp)
    return json.loads(raw.decode("utf-8")) if raw else {}


def contributor_fields(metadata):
    """Names of vector-layer fields that would expose OSM contributor identity."""
    bad = []
    for layer in metadata.get("vector_layers", []) or []:
        for field in (layer.get("fields") or {}):
            if field.lower() in FORBIDDEN_FIELDS:
                bad.append("%s.%s" % (layer.get("id"), field))
    return bad


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# ------------------------------------------------------------------ catalog
def catalog_entry(path, spec):
    """spec: name, kind, schema, licence, attribution, data_timestamp, url (optional)."""
    path = Path(path)
    header = read_header(path)
    meta = read_metadata(path, header)
    size = path.stat().st_size
    if size >= ASSET_LIMIT:
        raise ValueError("%s is %d bytes: not under the 2 GiB release asset limit" % (path.name, size))
    if header["tile_type"] != "mvt":
        raise ValueError("%s is not Mapbox Vector Tile data (%s)" % (path.name, header["tile_type"]))
    bad = contributor_fields(meta)
    if bad:
        raise ValueError("%s exposes contributor identity fields: %s" % (path.name, ", ".join(bad)))
    entry = {
        "name": spec["name"],
        "kind": spec.get("kind", "region"),
        "file": path.name,
        "format": "pmtiles-v3",
        "tile_type": "mvt",
        "tile_compression": header["tile_compression"],
        "bounds": [round(v, 7) for v in header["bounds"]],
        "min_zoom": header["min_zoom"],
        "max_zoom": header["max_zoom"],
        "bytes": size,
        "sha256": sha256(path),
        "tile_entries": header["tile_entries"],
        "schema": spec.get("schema"),
        "vector_layers": sorted(l.get("id") for l in meta.get("vector_layers", []) or []),
        "data_timestamp": spec.get("data_timestamp"),
        "licence": spec.get("licence", "ODbL-1.0"),
        "attribution": spec.get("attribution"),
    }
    for k in ("url", "source", "description", "schema_licence"):
        if spec.get(k):
            entry[k] = spec[k]
    if meta.get("attribution") and not entry.get("attribution"):
        entry["attribution"] = meta["attribution"]
    if meta.get("attribution"):
        entry["tileset_attribution"] = meta["attribution"]
    return entry


def build_catalog(entries, release, built_utc=None, extra=None):
    cat = {
        "catalog_version": 1,
        "name": "drivemate-offline-tiles",
        "built_utc": built_utc or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "release": release,
        "licence": "ODbL-1.0",
        "attribution": "(c) OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright",
        "notice": ("Prototype infrastructure: these tiles are for map display and research only "
                   "and are NOT approved for real driving guidance."),
        "signing": {"status": UNSIGNED},
        "tilesets": entries,
    }
    if extra:
        cat.update(extra)
    return cat


def catalog_bytes(cat):
    return (json.dumps(cat, indent=2, sort_keys=True) + "\n").encode("utf-8")


# ------------------------------------------------------------------ signing
def load_private_key(material):
    """Accept a PKCS#8 PEM, or a raw 32-byte seed as hex or base64."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization
    material = material.strip()
    if not material:
        return None
    if material.startswith("-----BEGIN"):
        key = serialization.load_pem_private_key(material.encode(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError("signing key is not Ed25519")
        return key
    try:
        seed = bytes.fromhex(material)
    except ValueError:
        seed = base64.b64decode(material, validate=True)
    if len(seed) != 32:
        raise ValueError("raw Ed25519 seed must be 32 bytes")
    return Ed25519PrivateKey.from_private_bytes(seed)


def public_raw(key):
    from cryptography.hazmat.primitives import serialization
    return key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def key_id(pub_raw):
    return hashlib.sha256(pub_raw).hexdigest()[:16]


def sign_catalog(cat, key):
    """Return (catalog bytes, detached signature text or None). Mutates cat['signing']."""
    if key is None:
        cat["signing"] = {"status": UNSIGNED,
                          "reason": "No CATALOG_TEST_SIGNING_KEY Actions secret is configured.",
                          "warning": TEST_KEY_WARNING}
        return catalog_bytes(cat), None
    pub = public_raw(key)
    cat["signing"] = {"status": "SIGNED-TEST-ONLY", "algorithm": "Ed25519",
                      "public_key_base64": base64.b64encode(pub).decode(),
                      "key_id": key_id(pub), "signature_file": "catalog.json.sig",
                      "warning": TEST_KEY_WARNING}
    data = catalog_bytes(cat)
    sig = base64.b64encode(key.sign(data)).decode() + "\n"
    return data, sig


def verify_signature(data, sig_text, pub_b64):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from cryptography.exceptions import InvalidSignature
    pub = Ed25519PublicKey.from_public_bytes(base64.b64decode(pub_b64))
    try:
        pub.verify(base64.b64decode(sig_text.strip()), data)
        return True
    except InvalidSignature:
        return False


# ---------------------------------------------------------------------- CLI
def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("poly2geojson")
    a.add_argument("poly", type=Path)
    a.add_argument("out", type=Path)
    a = sub.add_parser("inspect")
    a.add_argument("pmtiles", type=Path)
    a = sub.add_parser("build")
    a.add_argument("--spec", type=Path, required=True,
                   help="JSON list of {path, name, kind, schema, attribution, ...}")
    a.add_argument("--release", required=True)
    a.add_argument("--extra", type=Path, help="JSON object merged into the catalog")
    a.add_argument("--out", type=Path, required=True, help="output directory")
    a.add_argument("--key-env", default="CATALOG_TEST_SIGNING_KEY")
    a = sub.add_parser("verify")
    a.add_argument("catalog", type=Path)
    a.add_argument("sig", type=Path)
    a.add_argument("--pubkey", help="pinned public key (base64); default: the key named in the catalog")
    args = p.parse_args(argv)

    if args.cmd == "poly2geojson":
        geom = parse_poly(args.poly.read_text(encoding="utf-8"))
        fc = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"bounds": geometry_bounds(geom)}, "geometry": geom}]}
        args.out.write_text(json.dumps(fc), encoding="utf-8")
        print(args.out, geometry_bounds(geom))
    elif args.cmd == "inspect":
        h = read_header(args.pmtiles)
        m = read_metadata(args.pmtiles, h)
        print(json.dumps({"header": h, "metadata": {k: v for k, v in m.items() if k != "tilestats"}},
                         indent=2, default=str))
    elif args.cmd == "build":
        specs = json.loads(args.spec.read_text(encoding="utf-8"))
        entries = [catalog_entry(s["path"], s) for s in specs]
        extra = json.loads(args.extra.read_text(encoding="utf-8")) if args.extra else None
        cat = build_catalog(entries, args.release, extra=extra)
        key = load_private_key(os.environ.get(args.key_env, ""))
        data, sig = sign_catalog(cat, key)
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "catalog.json").write_bytes(data)
        sig_path = args.out / "catalog.json.sig"
        if sig:
            sig_path.write_text(sig, encoding="utf-8")
            (args.out / "catalog-test-signing-key.pub").write_text(
                cat["signing"]["public_key_base64"] + "\n", encoding="utf-8")
            assert verify_signature(data, sig, cat["signing"]["public_key_base64"])
            print("catalog signed with TEST-ONLY key", cat["signing"]["key_id"])
        else:
            if sig_path.exists():
                sig_path.unlink()
            print("catalog is UNSIGNED: add an Actions secret named %s (TEST-ONLY Ed25519 key)"
                  % args.key_env)
        print(data.decode())
    elif args.cmd == "verify":
        data = args.catalog.read_bytes()
        cat = json.loads(data)
        if cat.get("signing", {}).get("status") == UNSIGNED:
            raise SystemExit("catalog is UNSIGNED")
        # The app must pin the public key out of band; the copy in the catalog
        # only identifies which key signed it.
        pub = args.pubkey or cat["signing"]["public_key_base64"]
        ok = verify_signature(data, args.sig.read_text(), pub)
        print("signature OK" if ok else "signature INVALID")
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
