#!/usr/bin/env python3
"""Fetch a bounded OSM road extract via public Overpass servers (CI only).

Runs on GitHub Actions, whose runners have normal internet access, because
the development container cannot reach OSM download hosts. Downloads only
drivable highways, restriction relations and their nodes inside the
requested bounding box, validates the XML, and writes the extract plus a
provenance record (endpoint, query, timestamp, SHA-256, licence,
attribution). OSM data is (c) OpenStreetMap contributors, ODbL 1.0.
"""
import hashlib
import json
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
MAX_BYTES = 64 * 1024 * 1024
POI_KEYS = ("amenity", "shop", "tourism", "leisure", "historic", "office")
HIGHWAYS = ("motorway|trunk|primary|secondary|tertiary|unclassified|residential|"
            "living_street|service|motorway_link|trunk_link|primary_link|"
            "secondary_link|tertiary_link")


def query(bbox, include_places=False):
    s, w, n, e = bbox
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180) or (n - s) * (e - w) > 0.01:
        raise SystemExit("bbox invalid or larger than a small pilot town")
    b = "%.6f,%.6f,%.6f,%.6f" % (s, w, n, e)
    roads = ('way["highway"~"^(%s)$"](%s);'
             'way["route"="ferry"](%s);'
             'relation["type"="restriction"](%s);') % (HIGHWAYS, b, b, b)
    # This is an additive, separately reviewed data source: never replace the
    # proven M3 road extract or infer missing addresses from road geometry.
    places = ""
    if include_places:
        for kind in ("node", "way"):
            places += '%s["addr:housenumber"](%s);' % (kind, b)
            for key in POI_KEYS:
                places += '%s["name"]["%s"](%s);' % (kind, key, b)
    return '[out:xml][timeout:180];(' + roads + places + ');(._;>;);out body;'


def inventory(root):
    """Observed tagged OSM elements, not deduplicated usable addresses/POIs."""
    out = {}
    for kind in ("node", "way"):
        counts = {"explicit_addresses": 0, "named_pois": 0, "postcode_tags": 0}
        for element in root.findall(kind):
            tags = {t.get("k"): t.get("v") for t in element.findall("tag")}
            if tags.get("addr:housenumber") and tags.get("addr:street"):
                counts["explicit_addresses"] += 1
            if tags.get("name") and any(tags.get(key) for key in POI_KEYS):
                counts["named_pois"] += 1
            if tags.get("addr:postcode"):
                counts["postcode_tags"] += 1
        out[kind] = counts
    return out


def fetch(q):
    body = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for url in ENDPOINTS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, data=body, headers={
                    "User-Agent": "Drivemate-pilot-extract/1.0 (offline navigation research)"})
                with urllib.request.urlopen(req, timeout=240) as r:
                    data = r.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    raise ValueError("extract too large")
                root = ET.fromstring(data)
                if root.tag != "osm" or root.find("way") is None:
                    raise ValueError("response is not an OSM extract with ways")
                remark = root.find("remark")
                if remark is not None and "error" in (remark.text or "").lower():
                    raise ValueError("Overpass error: " + remark.text.strip()[:200])
                return url, data, root
            except Exception as problem:  # try the next attempt/endpoint
                last = "%s: %s" % (url, problem)
                print("fetch failed:", last, file=sys.stderr)
                time.sleep(10 * (attempt + 1))
    raise SystemExit("all Overpass endpoints failed; last: %s" % last)


def main(argv):
    request = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    name = request["name"]
    if not name.replace("-", "").isalnum():
        raise SystemExit("bad name")
    if type(request.get("include_places", False)) is not bool:
        raise SystemExit("include_places must be boolean")
    q = query(request["bbox"], request.get("include_places", False))
    out_dir = Path(argv[2] if len(argv) > 2 else "osm")
    if not request.get("refresh") and sorted(out_dir.glob(name + "-*.osm")):
        print("SKIP", name, "already has an extract; set \"refresh\": true to re-fetch")
        return
    url, data, root = fetch(q)
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out = Path(argv[2] if len(argv) > 2 else "osm")
    out.mkdir(parents=True, exist_ok=True)
    osm_path = out / ("%s-%s.osm" % (name, day))
    osm_path.write_bytes(data)
    meta = root.find("meta")
    provenance = {
        "name": name, "description": request.get("description", ""),
        "bbox": request["bbox"], "endpoint": url, "overpass_query": q,
        "osm_base": meta.get("osm_base") if meta is not None else None,
        "fetched_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
        "nodes": len(root.findall("node")), "ways": len(root.findall("way")),
        "relations": len(root.findall("relation")),
        "licence": "ODbL-1.0", "attribution": request["attribution"],
        "include_places": request.get("include_places", False),
        "tag_inventory": inventory(root),
        "usage": "M3 pilot research; derived road database; NOT approved for driving guidance",
    }
    (out / ("%s-%s.provenance.json" % (name, day))).write_text(
        json.dumps(provenance, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print("FETCHED", osm_path, provenance["bytes"], "bytes,", provenance["ways"], "ways,",
          provenance["relations"], "relations from", url)


if __name__ == "__main__":
    main(sys.argv)
