#!/usr/bin/env python3
"""Stream a verified UK OSM PBF into a DriveMate-owned, offline car road graph.

The routing graph is a separate deliverable from PMTiles display data.
Conservative exclusions for unknown access and conditional OSM tags. No traffic.
"""
import argparse
from collections import Counter
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import sys

FORMAT = "drivemate-uk-routing-v1"
ATTRIBUTION = "© OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright"
PART_BYTES = 850_000_000
DRIVABLE = set(("motorway trunk primary secondary tertiary unclassified residential "
                "living_street service motorway_link trunk_link primary_link "
                "secondary_link tertiary_link").split())
SPEED = {"motorway": 112, "trunk": 96, "primary": 80, "secondary": 64,
         "tertiary": 56, "unclassified": 48, "residential": 32,
         "living_street": 16, "service": 16, "motorway_link": 64,
         "trunk_link": 56, "primary_link": 48, "secondary_link": 40,
         "tertiary_link": 40}
DENY = set("no private agricultural forestry delivery customers permit emergency military discouraged".split())
ALLOW = set("yes permissive destination designated".split())
PASSABLE = set("cattle_grid toll_booth border_control entrance".split())
GATES = set("gate lift_gate swing_gate sliding_gate".split())
TURN_TYPES = set(("no_left_turn no_right_turn no_straight_on no_u_turn no_entry no_exit "
                  "only_left_turn only_right_turn only_straight_on only_u_turn").split())
PLACES = set("city town village hamlet suburb neighbourhood locality".split())


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def access(tags):
    answer = True
    for key in ("access", "vehicle", "motor_vehicle", "motorcar"):
        value = tags.get(key)
        if value is None:
            continue
        if value in DENY:
            answer = False
        elif value in ALLOW:
            answer = True
        else:
            return None
    return answer


def direction(tags):
    value = tags.get("oneway")
    if value is None:
        return "F" if tags.get("highway") in ("motorway", "motorway_link") or \
            tags.get("junction") in ("roundabout", "circular") else "B"
    return ("F" if value in ("yes", "true", "1") else
            "R" if value in ("-1", "reverse") else
            "B" if value in ("no", "false", "0") else None)


def kph(tags):
    raw = tags.get("maxspeed", "").strip().lower()
    if raw:
        try:
            speed = float(raw[:-3].strip()) * 1.609344 if raw.endswith("mph") else (
                float(raw[:-4].strip()) if raw.endswith("km/h") else float(raw))
            if not 5 <= speed <= 160:
                return None
            return speed
        except ValueError:
            pass  # Unknown designation: estimated travel time, never a displayed legal speed.
    return SPEED.get(tags.get("highway"), 10)


def distance(a, b):
    a1, a2 = map(math.radians, a)
    b1, b2 = map(math.radians, b)
    h = math.sin((b1-a1)/2)**2 + math.cos(a1)*math.cos(b1)*math.sin((b2-a2)/2)**2
    return 12742017.6 * math.asin(min(1, math.sqrt(h)))


def road_name(text):
    clean = "".join(c if c.isprintable() and c != "|" else " " for c in (text or ""))
    return " ".join(clean.split())[:80].strip()


class Builder:
    """OSM IDs preserve exact connections at nation/region boundaries."""
    def __init__(self, output):
        self.path = Path(output)
        self.db = sqlite3.connect(str(output))
        self.db.executescript("""
            PRAGMA journal_mode=DELETE;
            PRAGMA synchronous=OFF;
            CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE nodes(id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
            CREATE TABLE edges(id INTEGER PRIMARY KEY, src INTEGER NOT NULL, dst INTEGER NOT NULL,
                way INTEGER NOT NULL, metres REAL NOT NULL, seconds REAL NOT NULL,
                name TEXT NOT NULL, flags INTEGER NOT NULL);
            CREATE TABLE restrictions(via INTEGER NOT NULL, from_way INTEGER NOT NULL,
                to_way INTEGER NOT NULL, policy INTEGER NOT NULL);
            CREATE TABLE blocked(id INTEGER PRIMARY KEY);
            CREATE TABLE blocked_ways(id INTEGER PRIMARY KEY);
            CREATE TABLE places(name TEXT NOT NULL COLLATE NOCASE, lat REAL NOT NULL,
                lon REAL NOT NULL, kind TEXT NOT NULL);
        """)
        self.stats = Counter()
        self.node_buffer, self.edge_buffer = [], []
        self.next_edge = 0

    def node(self, node_id, lat, lon, tags):
        barrier = tags.get("barrier")
        if barrier and barrier not in PASSABLE:
            if barrier not in GATES or not any(k in tags for k in (
                    "access", "vehicle", "motor_vehicle", "motorcar")) or access(tags) is not True:
                self.db.execute("INSERT OR IGNORE INTO blocked VALUES (?)", (node_id,))
        if tags.get("place") in PLACES and tags.get("name"):
            self.db.execute("INSERT INTO places VALUES (?,?,?,?)",
                            (road_name(tags["name"]), lat, lon, tags["place"]))

    def way(self, way_id, tags, refs):
        highway = tags.get("highway")
        ferry = highway is None and tags.get("route") == "ferry"
        if highway not in DRIVABLE and not ferry:
            return
        if ferry and tags.get("motorcar") not in ALLOW and tags.get("motor_vehicle") not in ALLOW:
            self.stats["excluded_ferry_without_explicit_car_access"] += 1
            return
        if tags.get("area") == "yes" or access(tags) is not True or direction(tags) is None:
            self.stats["excluded_access_or_direction"] += 1
            return
        if any(key.endswith(":conditional") and not key.startswith("maxspeed") for key in tags):
            self.stats["excluded_conditional_access_or_direction"] += 1
            return
        speed = 10 if ferry else kph(tags)
        if speed is None or len(refs) < 2:
            self.stats["excluded_speed_or_short_way"] += 1
            return
        if any(not (math.isfinite(lat) and math.isfinite(lon) and
                    49 <= lat <= 61 and -9 <= lon <= 3) for _, lat, lon in refs):
            self.stats["excluded_missing_locations"] += 1
            return
        segs = []
        for (a, alat, alon), (b, blat, blon) in zip(refs, refs[1:]):
            meters = distance((alat, alon), (blat, blon))
            if a == b or not math.isfinite(meters) or meters <= 0.05:
                self.stats["excluded_invalid_segment"] += 1
                return
            segs.append((a, b, meters))
        if any(tags.get(k) not in (None, "yes", "no") for k in ("toll", "toll:motorcar")):
            self.stats["excluded_unknown_toll"] += 1
            return
        flags = (1 if highway in ("motorway", "motorway_link") else 0) | (
            2 if tags.get("toll:motorcar", tags.get("toll")) == "yes" else 0) | (
            4 if ferry else 0)
        name = road_name(tags.get("name") or tags.get("ref"))
        d = "B" if ferry else direction(tags)
        self.node_buffer.extend(refs)
        for a, b, meters in segs:
            for src, dst, permitted in ((a,b,d in ("F","B")), (b,a,d in ("R","B"))):
                if not permitted:
                    continue
                self.next_edge += 1
                self.edge_buffer.append((self.next_edge, src, dst, way_id,
                                         meters, meters/(speed/3.6), name, flags))
        self.stats["ways"] += 1
        if len(self.edge_buffer) >= 12000:
            self.flush()

    def turn(self, tags, members):
        if tags.get("type") != "restriction":
            return
        if set(tags.get("except", "").split(";")) & {"motorcar", "motor_vehicle"}:
            return
        kind = tags.get("restriction:motorcar") or tags.get("restriction:motor_vehicle") \
            or tags.get("restriction")
        if kind is None:
            cond = [v.split(" @ ")[0] for k, v in tags.items()
                    if k.startswith("restriction:") and k.endswith(":conditional")]
            if not cond:
                return  # other-vehicle restriction, not applicable to a car
            kind = cond[0]
        frm = [int(v) for r, t, v in members if r == "from" and t == "w"]
        to = [int(v) for r, t, v in members if r == "to" and t == "w"]
        via_nodes = [int(v) for r, t, v in members if r == "via" and t == "n"]
        via_ways = [int(v) for r, t, v in members if r == "via" and t == "w"]
        if len(frm) != 1 or len(to) != 1 or kind not in TURN_TYPES:
            uncertain = frm or to
            if uncertain:
                self.db.execute("INSERT OR IGNORE INTO blocked_ways VALUES (?)", (uncertain[0],))
            self.stats["conservatively_blocked_incomplete_turn"] += 1
            return
        if len(via_nodes) == 1 and not via_ways:
            via = via_nodes[0]
        elif len(via_ways) == 1 and not via_nodes:
            via, to = 0, via_ways
            self.stats["conservatively_blocked_via_way"] += 1
        else:
            self.db.execute("INSERT OR IGNORE INTO blocked_ways VALUES (?)", (frm[0],))
            self.stats["conservatively_blocked_incomplete_turn"] += 1
            return
        # Conditional turns deliberately enforce the restrictive policy all week,
        # until a time-aware on-road matcher is independently validated.
        policy = 4 if kind == "only_u_turn" else 3 if kind == "no_u_turn" \
            else 2 if kind.startswith("only_") else 1
        self.db.execute("INSERT INTO restrictions VALUES (?,?,?,?)",
                        (via, frm[0], to[0], policy))
        self.stats["turns"] += 1

    def flush(self):
        if self.node_buffer:
            self.db.executemany("INSERT OR IGNORE INTO nodes VALUES (?,?,?)", self.node_buffer)
            self.node_buffer.clear()
        if self.edge_buffer:
            self.db.executemany("INSERT INTO edges VALUES (?,?,?,?,?,?,?,?)", self.edge_buffer)
            self.edge_buffer.clear()

    def finish(self, tag, source_sha, min_edges=1):
        self.flush()
        self.stats["edges"] = self.next_edge
        self.stats["nodes"] = self.db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
        self.stats["places"] = self.db.execute("SELECT COUNT(*) FROM places").fetchone()[0]
        if self.next_edge < min_edges or self.stats["nodes"] < 2:
            raise ValueError("Routable graph empty/incomplete")
        self.db.executescript("""
            CREATE INDEX idx_edges_from ON edges(src);
            CREATE INDEX idx_turn_via_from ON restrictions(via,from_way);
            CREATE INDEX idx_nodes_lat ON nodes(lat,lon);
            CREATE INDEX idx_places_name ON places(name);
            CREATE INDEX idx_road_name ON edges(name COLLATE NOCASE) WHERE name <> '';
            PRAGMA user_version=1;
        """)
        self.db.executemany("INSERT INTO meta VALUES (?,?)", {
            "format": FORMAT, "source_tag": tag, "source_sha256": source_sha,
            "attribution": ATTRIBUTION, "vehicle": "motorcar",
            "guidance_status": "EXPERIMENTAL_NOT_ROAD_VALIDATED"}.items())
        self.db.commit()
        if self.db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("Routing SQLite integrity check failed")
        self.db.close()
        return dict(self.stats)


def load_osm(source, builder):
    """Stream an OSM PBF/XML file into builder. Shared by the release build and
    the Valhalla comparison harness so both test the identical import rules."""
    import osmium

    class OSM(osmium.SimpleHandler):
        def node(self, n):
            if n.tags.get("barrier") or n.tags.get("place"):
                builder.node(n.id, n.location.lat, n.location.lon, dict(n.tags))
        def way(self, w):
            if w.tags.get("highway") not in DRIVABLE and w.tags.get("route") != "ferry":
                return
            try:
                refs = [(n.ref, n.location.lat, n.location.lon) for n in w.nodes]
            except (ValueError, RuntimeError):
                builder.stats["excluded_missing_location"] += 1
                return
            builder.way(w.id, dict(w.tags), refs)
        def relation(self, r):
            if r.tags.get("type") == "restriction":
                builder.turn(dict(r.tags), [(m.role,m.type,m.ref) for m in r.members])

    OSM().apply_file(str(source), locations=True, idx="flex_mem")


def publish(db, folder, tag, source_sha, stats, part_bytes=PART_BYTES):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    gz = folder / "uk-routing.sqlite.gz"
    with gz.open("wb") as out:
        with gzip.GzipFile(fileobj=out, mode="wb", filename="", mtime=0, compresslevel=6) as target:
            with Path(db).open("rb") as source:
                for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
                    target.write(chunk)
    parts = []
    compressed = hashlib.sha256()
    with gz.open("rb") as source:
        for i in range(100):
            data = source.read(part_bytes)
            if not data:
                break
            name = "uk-routing.sqlite.gz.part-%03d" % i
            (folder / name).write_bytes(data)
            compressed.update(data)
            parts.append({"name": name, "bytes": len(data),
                          "sha256": hashlib.sha256(data).hexdigest()})
    if not parts or sum(p["bytes"] for p in parts) != gz.stat().st_size:
        raise ValueError("Routing pack exceeds maximum number of release parts")
    result = {"format": FORMAT, "source_tag": tag, "source_sha256": source_sha,
              "attribution": ATTRIBUTION, "licence": "ODbL-1.0",
              "database_bytes": Path(db).stat().st_size, "database_sha256": digest(db),
              "gzip_bytes": gz.stat().st_size, "gzip_sha256": compressed.hexdigest(),
              "builder_sha256": digest(Path(__file__)),
              "parts": parts, "counts": stats, "road_validated": False}
    (folder / "uk-routing-manifest.json").write_text(json.dumps(result, indent=2, sort_keys=True)+"\n")
    gz.unlink()
    return result


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--source-sha256", required=True)
    p.add_argument("--source-tag", required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--min-edges", type=int, default=1_000_000)
    a = p.parse_args(argv)
    if not re.fullmatch("[a-f0-9]{64}", a.source_sha256) or digest(a.source) != a.source_sha256:
        p.error("Published UK source SHA256 mismatch")
    if not re.fullmatch("uk-map-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}", a.source_tag):
        p.error("Published source release required")
    try:
        import osmium
    except ImportError:
        p.error("pyosmium must be installed before parsing the UK PBF")
    a.out.mkdir(parents=True, exist_ok=True)
    database = a.out / "uk-routing.sqlite"
    database.unlink(missing_ok=True)
    b = Builder(database)
    try:
        load_osm(a.source, b)
        stats = b.finish(a.source_tag, a.source_sha256, a.min_edges)
        manifest = publish(database, a.out, a.source_tag, a.source_sha256, stats)
        database.unlink()
    except Exception:
        try: b.db.close()
        except Exception: pass
        database.unlink(missing_ok=True)
        raise
    print("UK graph:", stats["nodes"], "nodes,", stats["edges"], "directed edges;",
          len(manifest["parts"]), "verified gzip parts. NOT ROAD VALIDATED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
