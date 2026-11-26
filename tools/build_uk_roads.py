#!/usr/bin/env python3
"""Stream a verified UK OSM PBF into a DriveMate-owned, offline car road graph.

The routing graph is a separate deliverable from PMTiles display data.
Conservative exclusions for unknown access and car-relevant conditional OSM tags. No traffic.
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
# Average driving speed (km/h) for a road with no signed limit, outside built-up
# areas. These are typical travel speeds, never shown as legal limits.
SPEED = {"motorway": 112, "trunk": 96, "primary": 80, "secondary": 64,
         "tertiary": 50, "unclassified": 42, "residential": 32,
         "living_street": 16, "service": 16, "motorway_link": 64,
         "trunk_link": 56, "primary_link": 48, "secondary_link": 40,
         "tertiary_link": 40}
# The same inside built-up areas, where junctions, parking and crossings slow
# traffic. Roads not listed keep SPEED.
URBAN_SPEED = {"trunk": 64, "primary": 48, "secondary": 45, "tertiary": 40,
               "unclassified": 35, "residential": 30}
# Built-up area: at least this many km of road per km2 in the 0.01-degree grid
# square (North East England: towns 10-21, countryside under 2).
URBAN_ROAD_KM_PER_KM2 = 7.0
URBAN_GRID = 0.01
# Typical speed driving round a roundabout, whatever its signed limit.
ROUNDABOUT_KPH = 25
DENY = set("no private agricultural forestry delivery customers permit emergency military discouraged".split())
ALLOW = set("yes permissive destination designated".split())
PASSABLE = set("cattle_grid toll_booth border_control entrance".split())
GATES = set("gate lift_gate swing_gate sliding_gate".split())
# A gate cars may use (no access tags, or a permissive one) is passable but may
# need opening or be closed briefly, so crossing it costs extra time.
GATE_PENALTY_S = 30
# Average delay for driving through a traffic-signal node. Off: measured
# against Valhalla on North East England (66 journeys), 0 s gave 100% route
# agreement, 10 s 92.4%, 20 s 89.4%, with no better time estimates, because a
# flat delay at every light sends routes on detours. Revisit with junction-
# aware delays (e.g. only when turning or crossing a major road).
SIGNAL_PENALTY_S = 0
# UK "restricted road": a lit road with no signed limit is 30 mph by law
# (Road Traffic Regulation Act 1984 s.81-82). Not applied to motorways.
RESTRICTED_ROAD_KPH = 30 * 1.609344
# Only these conditional tags change whether, or which way, a car may use a
# road. Until time-aware rules are modelled such roads are excluded; others
# (lorry weight limits, bus or bicycle lanes, parking) do not affect cars.
CAR_CONDITIONAL = set(k + ":conditional" for k in (
    "access", "vehicle", "motor_vehicle", "motorcar",
    "oneway", "oneway:vehicle", "oneway:motor_vehicle", "oneway:motorcar"))
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
    default = SPEED.get(tags.get("highway"), 10)
    if tags.get("lit") == "yes" and tags.get("highway") not in ("motorway", "motorway_link"):
        return min(default, RESTRICTED_ROAD_KPH)
    return default


CAR_HEIGHT_M = 2.0


def car_fits(tags):
    """A height restrictor stops cars only when its signed limit is below a car's
    height; most (e.g. 4.4 m tunnel portals) only stop lorries and buses."""
    raw = (tags.get("maxheight") or tags.get("maxheight:physical") or "").replace("m", "").strip()
    try:
        return float(raw) >= CAR_HEIGHT_M
    except ValueError:
        return not raw  # no limit given: assume it is for tall vehicles


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
        self.gates = set()  # passable gate nodes; nodes are read before ways
        self.signals = set()  # traffic-signal nodes
        self.road_m = Counter()  # road metres per URBAN_GRID square, for built-up detection
        self.unsigned = []  # (way, highway, speed, grid y, grid x) for roads with no signed limit
        self.via_way_rules = []  # (from, (via ways...), to, policy), expanded in finish()

    def node(self, node_id, lat, lon, tags):
        if tags.get("highway") == "traffic_signals":
            self.signals.add(node_id)
        barrier = tags.get("barrier")
        if barrier == "height_restrictor" and car_fits(tags):
            barrier = None
        if barrier and barrier not in PASSABLE:
            if barrier in GATES and access(tags) is True:
                self.gates.add(node_id)
                self.stats["gates_passable_with_penalty"] += 1
            else:
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
        if any(key in CAR_CONDITIONAL for key in tags):
            self.stats["excluded_conditional_access_or_direction"] += 1
            return
        speed = 10 if ferry else kph(tags)
        if speed is not None and not ferry and tags.get("junction") in ("roundabout", "circular"):
            speed = min(speed, ROUNDABOUT_KPH)
        if speed is None or len(refs) < 2:
            self.stats["excluded_speed_or_short_way"] += 1
            return
        if any(not (math.isfinite(lat) and math.isfinite(lon) and
                    49 <= lat <= 61 and -9 <= lon <= 3) for _, lat, lon in refs):
            self.stats["excluded_missing_locations"] += 1
            return
        segs = []
        unsigned = not ferry and not tags.get("maxspeed") and tags.get("highway") in URBAN_SPEED
        for (a, alat, alon), (b, blat, blon) in zip(refs, refs[1:]):
            meters = distance((alat, alon), (blat, blon))
            if a == b or not math.isfinite(meters) or meters <= 0.05:
                self.stats["excluded_invalid_segment"] += 1
                return
            segs.append((a, b, meters))
            g = (math.floor(alat / URBAN_GRID), math.floor(alon / URBAN_GRID))
            self.road_m[g] += meters
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
                seconds = meters/(speed/3.6) + (GATE_PENALTY_S if dst in self.gates else 0) + (
                    SIGNAL_PENALTY_S if dst in self.signals and not ferry else 0)
                self.edge_buffer.append((self.next_edge, src, dst, way_id,
                                         meters, seconds, name, flags))
        if unsigned:
            mid = refs[len(refs) // 2]
            self.unsigned.append((way_id, tags["highway"], speed,
                                  math.floor(mid[1] / URBAN_GRID), math.floor(mid[2] / URBAN_GRID)))
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
        if kind not in TURN_TYPES or not frm or not to or bool(via_nodes) == bool(via_ways) \
                or len(via_nodes) > 1:
            # Broken or unknown relation: ignored, as other routers do. (Blocking the
            # whole "from" road closed main roads such as Stratford Broadway.)
            self.stats["ignored_incomplete_or_unknown_restriction"] += 1
            return
        # Conditional turns deliberately enforce the restrictive policy all week,
        # until a time-aware on-road matcher is independently validated.
        policy = 4 if kind == "only_u_turn" else 3 if kind == "no_u_turn" \
            else 2 if kind.startswith("only_") else 1
        # Several from/to roads (allowed for no_entry / no_exit): every pair; for a
        # U-turn ban only same-road pairs.
        pairs = [(f, t) for f in frm for t in to if policy not in (3, 4) or f == t]
        if via_ways:
            for f, t in pairs:
                self.via_way_rules.append((f, tuple(via_ways), t, policy))
            self.stats["via_way_restrictions"] += len(pairs)
            return
        for f, t in pairs:
            self.db.execute("INSERT INTO restrictions VALUES (?,?,?,?)", (via_nodes[0], f, t, policy))
            self.stats["turns"] += 1

    def expand_via_ways(self):
        """Exact via-way restrictions ("from A, via B1..Bk, to C") by graph copy.

        The via chain is copied with new node and way ids. Only traffic arriving
        on A may enter the copy, A may no longer enter the original chain, and at
        the end of the copy the exit onto C is removed (no_*) or is the only one
        kept (only_*). Side roads along the chain are copied too, so turning off
        early stays possible. Routing engines need no change. Copy nodes are
        never journey ends (copy_nodes); copied ways map to the original
        (way_alias). A chain that cannot be followed falls back to a local ban
        at its final junction, never to closing a whole road."""
        if not self.via_way_rules:
            return
        db = self.db
        db.executescript("""
            CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(src);
            CREATE INDEX IF NOT EXISTS idx_edges_way ON edges(way);
            CREATE TABLE copy_nodes(id INTEGER PRIMARY KEY, original INTEGER NOT NULL);
            CREATE TABLE way_alias(id INTEGER PRIMARY KEY, original INTEGER NOT NULL);
        """)
        blocked = {r[0] for r in db.execute("SELECT id FROM blocked")}
        def out_edges(n):
            return db.execute("SELECT id,src,dst,way,metres,seconds,name,flags FROM edges WHERE src=?",
                              (n,)).fetchall()
        def touches(n, way):
            return db.execute("SELECT 1 FROM edges WHERE src=? AND way=? LIMIT 1", (n, way)).fetchone()
        def chain_from(start, ways, target):
            """Node path from start along ways[0], ways[1], ... to a node with an exit
            onto target; follows each way without branching."""
            path, prev = [start], None
            for i, way in enumerate(ways):
                nxt = ways[i + 1] if i + 1 < len(ways) else target
                options = [e for e in out_edges(path[-1]) if e[3] == way and e[2] != prev]
                found = None
                for first in options:
                    seg, p, cur = [first[2]], path[-1], first[2]
                    for _ in range(400):
                        if touches(cur, nxt) and (nxt != way):
                            found = seg
                            break
                        step = [e for e in out_edges(cur) if e[3] == way and e[2] != p]
                        if len(step) != 1:
                            break
                        p, cur = cur, step[0][2]
                        seg.append(cur)
                    if found:
                        break
                if not found:
                    return None
                prev = path[-1] if len(found) == 1 else found[-2]
                path.extend(found)
            return path
        # Group restrictions sharing (from, via chain): one copy carries all of them.
        groups = {}
        for f, via, t, policy in self.via_way_rules:
            groups.setdefault((f, via), []).append((t, policy))
        firsts = Counter((f, via[0]) for f, via in groups)
        node_id = max(db.execute("SELECT MAX(id) FROM nodes").fetchone()[0], 0) + 10**12
        way_id = max(db.execute("SELECT MAX(way) FROM edges").fetchone()[0], 0) + 10**12
        edge_id = self.next_edge
        def fallback(f, via, rules):
            # Local ban where the chain ends, applied to anyone arriving on the last via way.
            ends = db.execute("""SELECT DISTINCT e.src FROM edges e WHERE e.way=? AND EXISTS
                (SELECT 1 FROM edges c WHERE c.src=e.src AND c.way IN (%s))""" % ",".join(
                    str(t) for t, _ in rules), (via[-1],)).fetchall()
            for (n,) in ends:
                for t, policy in rules:
                    db.execute("INSERT INTO restrictions VALUES (?,?,?,?)", (n, via[-1], t, 1 if policy in (1, 3) else 2))
            self.stats["via_way_local_fallback"] += 1
        for (f, via), rules in groups.items():
            targets = {t for t, _ in rules}
            only = any(p in (2, 4) for _, p in rules)
            if firsts[(f, via[0])] > 1:
                fallback(f, via, rules)  # overlapping chains from the same road
                continue
            starts = [r[0] for r in db.execute("""SELECT DISTINCT a.dst FROM edges a WHERE a.way=?
                AND EXISTS (SELECT 1 FROM edges b WHERE b.src=a.dst AND b.way=?)""", (f, via[0]))]
            path = None
            for j0 in starts:
                path = chain_from(j0, list(via), next(iter(targets)))
                if path:
                    break
            if not path or any(n in blocked for n in path[1:]):
                fallback(f, via, rules)
                continue
            j0 = path[0]
            fake = {}
            for w in via:
                way_id += 1
                fake[w] = way_id
                db.execute("INSERT INTO way_alias VALUES (?,?)", (way_id, w))
            copies = {}
            for n in path[1:]:
                node_id += 1
                copies[n] = node_id
                db.execute("INSERT INTO nodes SELECT ?,lat,lon FROM nodes WHERE id=?", (node_id, n))
                db.execute("INSERT INTO copy_nodes VALUES (?,?)", (node_id, n))
            new_edges = []
            # J0 -> first copy, on the copied first via way.
            for e in out_edges(j0):
                if e[2] == path[1] and e[3] == via[0]:
                    edge_id += 1
                    new_edges.append((edge_id, j0, copies[path[1]], fake[via[0]]) + tuple(e[4:]))
                    break
            last = len(path) - 1
            for i in range(1, len(path)):
                n, c = path[i], copies[path[i]]
                for e in out_edges(n):
                    _, _, dst, way, metres, seconds, name, flags = e
                    if dst == path[i - 1]:
                        continue  # no U-turn back along the chain inside the copy
                    if i < last and dst == path[i + 1] and way in fake:
                        dst, way = copies[dst], fake[way]
                    elif i == last:
                        if (way in targets) == (not only):
                            continue  # the restricted exit (no_*) / every other exit (only_*)
                    edge_id += 1
                    new_edges.append((edge_id, c, dst, way, metres, seconds, name, flags))
                # Turn rules at the original node also apply at its copy.
                for frm_w, to_w, policy in db.execute(
                        "SELECT from_way,to_way,policy FROM restrictions WHERE via=?", (n,)).fetchall():
                    if frm_w in fake:
                        db.execute("INSERT INTO restrictions VALUES (?,?,?,?)",
                                   (c, fake[frm_w], fake.get(to_w, to_w), policy))
            db.executemany("INSERT INTO edges VALUES (?,?,?,?,?,?,?,?)", new_edges)
            # At J0: A may not enter the original chain; only A may enter the copy.
            db.execute("INSERT INTO restrictions VALUES (?,?,?,?)", (j0, f, via[0], 1))
            for (x,) in db.execute("SELECT DISTINCT way FROM edges WHERE dst=? AND way<>?", (j0, f)).fetchall():
                db.execute("INSERT INTO restrictions VALUES (?,?,?,?)", (j0, x, fake[via[0]], 1))
            for (policy,) in db.execute("SELECT policy FROM restrictions WHERE via=? AND from_way=? AND to_way=? AND policy IN (2,4)",
                                        (j0, f, via[0])).fetchall():
                db.execute("INSERT INTO restrictions VALUES (?,?,?,?)", (j0, f, fake[via[0]], policy))
            self.stats["via_way_exact"] += 1
        self.next_edge = edge_id
        db.execute("DROP INDEX idx_edges_way")

    def flush(self):
        if self.node_buffer:
            self.db.executemany("INSERT OR IGNORE INTO nodes VALUES (?,?,?)", self.node_buffer)
            self.node_buffer.clear()
        if self.edge_buffer:
            self.db.executemany("INSERT INTO edges VALUES (?,?,?,?,?,?,?,?)", self.edge_buffer)
            self.edge_buffer.clear()

    def urban_speeds(self):
        """Slow roads with no signed limit in built-up areas to URBAN_SPEED.
        Density is only known once every road is read, so edges are adjusted
        here: seconds += metres * (1/new - 1/old), keeping gate penalties."""
        factors = []
        for way, highway, old, gy, gx in self.unsigned:
            area = (URBAN_GRID * 111.195) ** 2 * math.cos(math.radians((gy + .5) * URBAN_GRID))
            if self.road_m[(gy, gx)] / 1000 / area < URBAN_ROAD_KM_PER_KM2:
                continue
            new = min(old, URBAN_SPEED[highway])
            if new < old:
                factors.append((way, 3.6 / new - 3.6 / old))
        self.stats["urban_unsigned_roads"] = len(factors)
        if factors:
            self.db.execute("CREATE TEMP TABLE urban(way INTEGER PRIMARY KEY, f REAL NOT NULL)")
            self.db.executemany("INSERT OR REPLACE INTO urban VALUES (?,?)", factors)
            self.db.execute("""UPDATE edges SET seconds = seconds + metres *
                (SELECT f FROM urban WHERE urban.way = edges.way)
                WHERE way IN (SELECT way FROM urban)""")
            self.db.execute("DROP TABLE urban")

    def finish(self, tag, source_sha, min_edges=1):
        self.flush()
        self.urban_speeds()
        self.expand_via_ways()
        self.stats["edges"] = self.next_edge
        self.stats["nodes"] = self.db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
        self.stats["places"] = self.db.execute("SELECT COUNT(*) FROM places").fetchone()[0]
        if self.next_edge < min_edges or self.stats["nodes"] < 2:
            raise ValueError("Routable graph empty/incomplete")
        self.db.executescript("""
            CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(src);
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
            if n.tags.get("barrier") or n.tags.get("place") or n.tags.get("highway") == "traffic_signals":
                builder.node(n.id, n.location.lat, n.location.lon, dict(n.tags))
        def way(self, w):
            if w.tags.get("highway") not in DRIVABLE and w.tags.get("route") != "ferry":
                return
            try:
                refs = [(n.ref, n.location.lat, n.location.lon) for n in w.nodes]
            except (ValueError, RuntimeError, getattr(osmium, "InvalidLocationError", ValueError)):
                # A way reaching outside the extract (regional files) has no location for
                # some nodes; newer pyosmium raises InvalidLocationError for that.
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
