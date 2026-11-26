#!/usr/bin/env python3
"""Differential test of DriveMate's own router against Valhalla.

Valhalla is used only as an outside yardstick here: it is run by this test,
never shipped in or linked into DriveMate. Both engines are built from the
same OSM file, then asked the same journeys. Every disagreement is classified
and located (the OSM ways where the routes split) so it can be investigated
and fixed in DriveMate's own importer, cost model or search. A disagreement
is not automatically a DriveMate bug: Valhalla can be wrong too, so each
category says what to check.

Typical loop:
  python3 tools/compare_with_valhalla.py --pbf region.osm.pbf --work /tmp/cmp \\
      --report report.json --markdown report.md
  # fix something in DriveMate, rebuild, then compare against the last run:
  python3 tools/compare_with_valhalla.py ... --baseline report.json

Needs: osmium and pyvalhalla (tools/valhalla-compare-requirements.txt).
NOT a road-safety validation of either engine.
"""
import argparse
import hashlib
import json
import math
import os
import random
import sqlite3
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

NEAR_M = 30          # a point counts as "on the other route" within this distance
SNAP_WARN_M = 150    # snapped start/end further than this from the request
BANDS_KM = ((1, 5), (5, 20), (20, 60), (60, 160))
# Real places, so named failures are easy to reason about. Only used when
# both ends fall inside the built region.
NAMED = (
    ("Newcastle to Durham", (54.9738, -1.6131), (54.7761, -1.5733)),
    ("Sunderland to Hexham", (54.9069, -1.3838), (54.9718, -2.1013)),
    ("Middlesbrough to Berwick", (54.5742, -1.2350), (55.7704, -2.0054)),
    ("Darlington to Alnwick", (54.5236, -1.5595), (55.4130, -1.7066)),
    ("Gateshead to Newcastle Airport", (54.9527, -1.6034), (55.0375, -1.6917)),
    ("Hartlepool to Consett", (54.6863, -1.2129), (54.8540, -1.8316)),
)

VERDICT_HELP = {
    "match": "Same route (within tolerance).",
    "equivalent": "Different roads; Valhalla rates our route within 2% of its own.",
    "ours_better": "Different roads; Valhalla rates our route more than 2% faster than its own.",
    "valhalla_better": "Valhalla rates its own route 2-10% faster than ours. Check speeds and turns on both routes.",
    "ours_failed": "Valhalla found a route; DriveMate did not. Check snapping, search limits and roads the importer dropped.",
    "valhalla_failed": "DriveMate found a route Valhalla refused. Check access/legality on our route: we may use a road cars cannot.",
    "ours_slower": "Valhalla rates our route clearly slower than its own. Check our speed model and missed faster roads.",
    "ours_shorter": "Our route is much shorter and Valhalla could not match it to drivable roads. Check restrictions, access or one-ways we miss.",
    "both_failed": "Neither engine routed. Usually bad journey endpoints, not an engine bug.",
}


# ---------------------------------------------------------------- geometry
def metres(a, b):
    la, lo = math.radians(a[0]), math.radians(a[1])
    lb, ln = math.radians(b[0]), math.radians(b[1])
    h = math.sin((lb-la)/2)**2 + math.cos(la)*math.cos(lb)*math.sin((ln-lo)/2)**2
    return 12742017.6 * math.asin(min(1, math.sqrt(h)))


def decode_polyline6(text):
    """Valhalla shape string -> [(lat, lon)]. Own implementation."""
    out, index, lat, lon = [], 0, 0, 0
    while index < len(text):
        for axis in (0, 1):
            shift = result = 0
            while True:
                b = ord(text[index]) - 63
                index += 1
                result |= (b & 0x1f) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if axis == 0:
                lat += delta
            else:
                lon += delta
        out.append((lat / 1e6, lon / 1e6))
    return out


def densify(points, step=15.0):
    out = []
    for a, b in zip(points, points[1:]):
        d = metres(a, b)
        n = max(1, int(d // step))
        for i in range(n):
            t = i / n
            out.append((a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t))
    if points:
        out.append(points[-1])
    return out


class PointIndex:
    """Grid of densified route points for fast 'is this near the route' tests."""
    CELL = 0.0005  # about 55 m of latitude

    def __init__(self, points):
        self.grid = {}
        for p in densify(points):
            self.grid.setdefault(self._key(p), []).append(p)

    def _key(self, p):
        return (int(math.floor(p[0] / self.CELL)), int(math.floor(p[1] / self.CELL)))

    def near(self, p, radius=NEAR_M):
        ky, kx = self._key(p)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for q in self.grid.get((ky+dy, kx+dx), ()):
                    if metres(p, q) <= radius:
                        return True
        return False


def coverage(points, other_index):
    """Share of the length of `points` that runs along the other route."""
    pts = densify(points)
    if len(pts) < 2:
        return 0.0
    total = covered = 0.0
    for a, b in zip(pts, pts[1:]):
        d = metres(a, b)
        total += d
        if other_index.near(a) and other_index.near(b):
            covered += d
    return covered / total if total else 0.0


def first_split(points, ways, other_index):
    """First place where `points` leaves the other route, with the way used."""
    for i, p in enumerate(points):
        if not other_index.near(p):
            way = ways[i-1] if 0 < i <= len(ways) else (ways[0] if ways else None)
            return {"lat": round(p[0], 6), "lon": round(p[1], 6), "osm_way": way,
                    "route_km_from_start": round(sum(metres(a, b) for a, b in zip(points[:i], points[1:i+1])) / 1000, 2)}
    return None


# --------------------------------------------------------------- verdicts
def classify(ours, vh, ours_vh_seconds=None):
    """Pure function: two engine results -> verdict and the numbers behind it."""
    if not ours["ok"] and not vh["ok"]:
        return "both_failed", {}
    if not ours["ok"]:
        return "ours_failed", {}
    if not vh["ok"]:
        return "valhalla_failed", {}
    ratio = ours["km"] / vh["km"] if vh["km"] else math.inf
    sim = min(ours["coverage"], vh["coverage"])
    slower = (ours_vh_seconds / vh["seconds"]) if ours_vh_seconds and vh["seconds"] else None
    facts = {"distance_ratio": round(ratio, 3), "similarity": round(sim, 3)}
    if slower is not None:
        facts["valhalla_time_ratio_of_our_route"] = round(slower, 3)
    if sim >= 0.9 or (sim >= 0.75 and abs(ratio - 1) <= 0.03):
        return "match", facts
    if slower is not None:
        # Valhalla accepted our route as drivable and timed it: judge on time.
        # (Valhalla also adds turn/road-class penalties, so its pick can be longer.)
        if slower > 1.10:
            return "ours_slower", facts
        if slower > 1.02:
            return "valhalla_better", facts
        if slower < 0.98:
            return "ours_better", facts
        return "equivalent", facts
    # Valhalla could not map-match our route: treat a much shorter route as suspect.
    if ratio < 0.93:
        return "ours_shorter", facts
    if ratio > 1.10:
        return "ours_slower", facts
    return "equivalent", facts


# Journeys where DriveMate matches or beats Valhalla.
GOOD = ("match", "equivalent", "ours_better")


def score(records):
    counts = {}
    for r in records:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    judged = len(records) - counts.get("both_failed", 0)
    good = sum(counts.get(v, 0) for v in GOOD)
    return counts, (round(100 * good / judged, 1) if judged else 0.0)


# ------------------------------------------------------------------ builds
def sha256(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(8 << 20), b""):
            h.update(block)
    return h.hexdigest()


def builder_fingerprint():
    """Rebuild our graph whenever DriveMate's importer or compiler changes."""
    here = Path(__file__).resolve().parent
    h = hashlib.sha256()
    for name in ("build_uk_roads.py", "compile_dmtiles_uk.py", "compile_dmtiles.py", "dm_overlay.py"):
        h.update((here / name).read_bytes())
    return h.hexdigest()


def build_drivemate(pbf, work, source_sha):
    import build_uk_roads as uk
    from compile_dmtiles_uk import compile_graph
    out = Path(work) / "drivemate"
    stamp = out / "stamp.json"
    want = {"source_sha256": source_sha, "builder": builder_fingerprint()}
    if stamp.exists() and json.loads(stamp.read_text()) == want:
        return out
    out.mkdir(parents=True, exist_ok=True)
    db = out / "graph.sqlite"
    db.unlink(missing_ok=True)
    tag = "uk-map-compare-" + source_sha[:12]
    b = uk.Builder(db)
    uk.load_osm(pbf, b)
    stats = b.finish(tag, source_sha, 1)
    manifest = uk.publish(db, out / "pack", tag, source_sha, stats)
    for part in (out / "pack").glob("*.part-*"):
        part.unlink()
    compile_graph(db, manifest, out / "tiles", pilot=True)
    from dm_overlay import build_level2, build_overlay
    build_overlay(out / "tiles")  # road hierarchy, levels 1 and 2: the engine under test uses it
    build_level2(out / "tiles")
    stamp.write_text(json.dumps(want))
    return out


def valhalla_bin_dir():
    import valhalla
    return Path(valhalla.__file__).resolve().parent / "bin"


def build_valhalla(pbf, work, source_sha):
    import valhalla
    out = Path(work) / "valhalla"
    stamp = out / "stamp.json"
    want = {"source_sha256": source_sha, "valhalla": getattr(valhalla, "__version__", "?")}
    config_path = out / "valhalla.json"
    if stamp.exists() and json.loads(stamp.read_text()) == want:
        return config_path
    tiles = out / "tiles"
    tiles.mkdir(parents=True, exist_ok=True)
    config = valhalla.get_config(tile_extract="", tile_dir=str(tiles))
    config_path.write_text(json.dumps(config, indent=1))
    env = dict(os.environ, PATH=str(valhalla_bin_dir()) + os.pathsep + os.environ.get("PATH", ""))
    with (out / "build.log").open("w") as log:
        subprocess.run([str(valhalla_bin_dir() / "valhalla_build_tiles"), "-c", str(config_path), str(pbf)],
                       check=True, stdout=log, stderr=subprocess.STDOUT, env=env)
    stamp.write_text(json.dumps(want))
    return config_path


# ---------------------------------------------------------------- journeys
def pick_journeys(db_path, count, seed, bounds):
    """Deterministic journeys between nodes on through-roads (>=25 km/h)."""
    db = sqlite3.connect(str(db_path))
    rows = db.execute("""SELECT DISTINCT n.lat, n.lon FROM edges e JOIN nodes n ON n.id = e.src
                         WHERE e.metres / e.seconds * 3.6 >= 25 ORDER BY n.id""").fetchall()
    db.close()
    rng = random.Random(seed)
    journeys = []
    for name, a, b in NAMED:
        if all(bounds[0] <= p[0] <= bounds[2] and bounds[1] <= p[1] <= bounds[3] for p in (a, b)):
            journeys.append({"name": name, "start": a, "end": b})
    per_band = max(1, count // len(BANDS_KM))
    for lo, hi in BANDS_KM:
        made = tries = 0
        while made < per_band and tries < per_band * 400:
            tries += 1
            a, b = rng.choice(rows), rng.choice(rows)
            if lo * 1000 <= metres(a, b) <= hi * 1000:
                made += 1
                journeys.append({"name": f"random {lo}-{hi} km #{made}",
                                 "start": (round(a[0], 6), round(a[1], 6)),
                                 "end": (round(b[0], 6), round(b[1], 6))})
    return journeys


# ----------------------------------------------------------------- routing
_W = {}


def _worker_init(manifest, archive, config, expansions, seconds):
    import valhalla
    from benchmark_dmtiles_uk import Archive
    _W.update(archive=Archive(manifest, archive), actor=valhalla.Actor(str(config)),
              expansions=expansions, seconds=seconds)


def route_valhalla(actor, start, end):
    req = {"locations": [{"lat": start[0], "lon": start[1]}, {"lat": end[0], "lon": end[1]}],
           "costing": "auto", "directions_type": "none"}
    try:
        trip = json.loads(actor.route(json.dumps(req)))["trip"]
    except Exception as e:  # Valhalla raises on "no route"
        return {"ok": False, "reason": str(e)[:200]}
    shape = []
    for leg in trip["legs"]:
        pts = decode_polyline6(leg["shape"])
        shape.extend(pts if not shape else pts[1:])
    return {"ok": True, "km": trip["summary"]["length"], "seconds": trip["summary"]["time"], "shape": shape}


def valhalla_time_of(actor, points):
    """Valhalla's travel time for OUR route, by map-matching our geometry."""
    pts = points[::max(1, len(points) // 4000)] + [points[-1]]
    req = {"shape": [{"lat": p[0], "lon": p[1]} for p in pts], "costing": "auto",
           "shape_match": "map_snap", "directions_type": "none"}
    try:
        return json.loads(actor.trace_route(json.dumps(req)))["trip"]["summary"]["time"]
    except Exception:
        return None


def run_journey(j):
    ar, actor = _W["archive"], _W["actor"]
    ar.allowed = None
    raw = ar.route(tuple(j["start"]), tuple(j["end"]), _W["expansions"], _W["seconds"])
    ours = {"ok": raw["ok"], "reason": raw.get("reason"), "expanded": raw.get("expanded"),
            "elapsed_seconds": raw.get("elapsed_seconds")}
    ours_pts, ways = [], []
    if raw["ok"]:
        ours_pts = [(lat, lon) for _, lat, lon in raw["path"]]
        ways = raw["ways"]
        ours.update(km=raw["distance_km"], seconds=raw["seconds"])
        if metres(ours_pts[0], j["start"]) > SNAP_WARN_M or metres(ours_pts[-1], j["end"]) > SNAP_WARN_M:
            ours["snap_warning"] = True
    vh = route_valhalla(actor, j["start"], j["end"])
    rec = {"name": j["name"], "start": list(j["start"]), "end": list(j["end"]),
           "straight_km": round(metres(j["start"], j["end"]) / 1000, 2)}
    ours_vh_seconds = None
    if ours["ok"] and vh["ok"]:
        vi, oi = PointIndex(vh["shape"]), PointIndex(ours_pts)
        ours["coverage"] = round(coverage(ours_pts, vi), 3)
        vh["coverage"] = round(coverage(vh["shape"], oi), 3)
        ours_vh_seconds = valhalla_time_of(actor, ours_pts)
        rec["split"] = first_split(ours_pts, ways, vi)
    verdict, facts = classify(ours, vh, ours_vh_seconds)
    rec.update(verdict=verdict, facts=facts,
               ours={k: v for k, v in ours.items() if v is not None},
               valhalla={k: v for k, v in vh.items() if k != "shape"})
    if ours_vh_seconds:
        rec["valhalla"]["seconds_for_our_route"] = round(ours_vh_seconds, 1)
    return rec


# ----------------------------------------------------------------- reports
def osm_link(lat, lon):
    return f"https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=17/{lat}/{lon}"


def markdown(report, baseline=None):
    s = report["summary"]
    lines = ["# DriveMate vs Valhalla", "",
             f"Source: `{report['source_sha256'][:12]}`, {s['journeys']} journeys, "
             f"match-or-beat score **{s['score']}%** (same route, within 2%, or ours faster by Valhalla's own timing; "
             "journeys neither engine could route excluded).", ""]
    if baseline:
        b = baseline["summary"]
        lines += [f"Baseline score {b['score']}% -> now {s['score']}% ({s['score'] - b['score']:+.1f}).", ""]
    lines += ["| Verdict | Count | What to check |", "|---|---|---|"]
    for v, help_text in VERDICT_HELP.items():
        lines.append(f"| {v} | {s['counts'].get(v, 0)} | {help_text} |")
    bad = [r for r in report["journeys"] if r["verdict"] not in GOOD + ("both_failed",)]
    if bad:
        lines += ["", "## Disagreements to investigate", "",
                  "| Journey | Verdict | Ours | Valhalla | Where routes split |", "|---|---|---|---|---|"]
        for r in sorted(bad, key=lambda r: r["verdict"]):
            o, v = r["ours"], r["valhalla"]
            ours_txt = f"{o['km']} km / {round(o['seconds']/60, 1)} min" if o.get("ok") else f"no route ({o.get('reason')})"
            vh_txt = f"{round(v['km'], 2)} km / {round(v['seconds']/60, 1)} min" if v.get("ok") else "no route"
            sp = r.get("split")
            where = (f"[{sp['lat']},{sp['lon']}]({osm_link(sp['lat'], sp['lon'])}) way "
                     f"[{sp['osm_way']}](https://www.openstreetmap.org/way/{sp['osm_way']}) after {sp['route_km_from_start']} km"
                     if sp else "")
            lines.append(f"| {r['name']} | {r['verdict']} | {ours_txt} | {vh_txt} | {where} |")
    if baseline:
        before = {r["name"]: r["verdict"] for r in baseline["journeys"]}
        changed = [(r["name"], before[r["name"]], r["verdict"]) for r in report["journeys"]
                   if r["name"] in before and before[r["name"]] != r["verdict"]]
        if changed:
            lines += ["", "## Changed since baseline", "", "| Journey | Before | Now |", "|---|---|---|"]
            lines += [f"| {n} | {a} | {b} |" for n, a, b in changed]
    lines += ["", "Engineering comparison only. Not a road-safety validation of either engine. "
              "Map data © OpenStreetMap contributors, ODbL 1.0."]
    return "\n".join(lines) + "\n"


def regressions(report, baseline):
    good = GOOD
    before = {r["name"]: r["verdict"] for r in baseline["journeys"]}
    return [r["name"] for r in report["journeys"]
            if before.get(r["name"]) in good and r["verdict"] not in good]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--pbf", type=Path, required=True)
    p.add_argument("--work", type=Path, required=True, help="cache folder for both engines' built data")
    p.add_argument("--journeys", type=int, default=60, help="random journeys, spread over distance bands")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--expansions", type=int, default=350000)
    p.add_argument("--seconds", type=int, default=90)
    p.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    p.add_argument("--report", type=Path, required=True)
    p.add_argument("--markdown", type=Path)
    p.add_argument("--baseline", type=Path, help="earlier report: show changes and catch regressions")
    p.add_argument("--fail-on-regression", action="store_true")
    a = p.parse_args(argv)

    source_sha = sha256(a.pbf)
    t0 = time.monotonic()
    ours_dir = build_drivemate(a.pbf, a.work, source_sha)
    print(f"DriveMate graph ready ({time.monotonic()-t0:.0f}s)", flush=True)
    config = build_valhalla(a.pbf, a.work, source_sha)
    print(f"Valhalla tiles ready ({time.monotonic()-t0:.0f}s)", flush=True)

    db = ours_dir / "graph.sqlite"
    con = sqlite3.connect(str(db))
    bounds = con.execute("SELECT MIN(lat), MIN(lon), MAX(lat), MAX(lon) FROM nodes").fetchone()
    con.close()
    baseline = json.loads(a.baseline.read_text()) if a.baseline else None
    if baseline:  # same journeys as before, so changes are like-for-like
        journeys = [{"name": r["name"], "start": tuple(r["start"]), "end": tuple(r["end"])}
                    for r in baseline["journeys"]]
    else:
        journeys = pick_journeys(db, a.journeys, a.seed, bounds)
    tiles = ours_dir / "tiles"
    init = (str(tiles / "manifest.json"), str(tiles / "routing.dma"), config, a.expansions, a.seconds)
    records = []
    with ProcessPoolExecutor(a.workers, initializer=_worker_init, initargs=init) as pool:
        for rec in pool.map(run_journey, journeys):
            records.append(rec)
            print(f"{rec['verdict']:>16}  {rec['name']}", flush=True)
    counts, pct = score(records)
    report = {"source_sha256": source_sha, "drivemate_builder_sha256": builder_fingerprint(),
              "engine": "DriveMate Python mirror of DmTileEngine with road hierarchy (not the Android build)",
              "settings": {"expansions": a.expansions, "seconds": a.seconds, "seed": a.seed, "near_m": NEAR_M},
              "summary": {"journeys": len(records), "counts": counts, "score": pct},
              "journeys": records, "road_validated": False}
    a.report.write_text(json.dumps(report, indent=1) + "\n")
    md = markdown(report, baseline)
    if a.markdown:
        a.markdown.write_text(md)
    print(md)
    if baseline and a.fail_on_regression:
        lost = regressions(report, baseline)
        if lost:
            print("Regressed journeys:", ", ".join(lost))
            return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
