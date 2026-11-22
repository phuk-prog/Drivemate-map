#!/usr/bin/env python3
"""Exercise real car routes and Valhalla manoeuvres against newly built UK tiles.

Runs pinned Valhalla in one-shot mode against the actual local tiles.tar,
without needing a public HTTP service. A graph failing ANY representative
sample cannot be packaged as a complete nationwide candidate. This is
engineering coverage, NOT on-road legal/safety verification.
"""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys

# Same five geographically separated checks as the released SQLite graph QA.
SAMPLES = (
    ("England: Birmingham to Coventry", (52.486, -1.890), (52.408, -1.510)),
    ("England/Wales: Bristol to Chepstow", (51.454, -2.588), (51.641, -2.675)),
    ("England/Scotland: Carlisle to Dumfries", (54.895, -2.938), (55.070, -3.604)),
    ("Scotland: Edinburgh to Livingston", (55.954, -3.189), (55.883, -3.522)),
    ("Northern Ireland: Belfast to Lisburn", (54.597, -5.930), (54.516, -6.058)),
)


def route_request(start, destination):
    return {
        "locations": [{"lat": a, "lon": b} for a, b in (start, destination)],
        "costing": "auto",
        "directions_options": {"units": "kilometers"},
    }


def validate_response(payload):
    """Require route geometry, travel time, ordered manoeuvres and arrival."""
    if not isinstance(payload, dict):
        raise ValueError("Valhalla route response is not an object")
    trip = payload.get("trip")
    if not isinstance(trip, dict):
        raise ValueError("Valhalla returned no connected car route")
    if trip.get("status", 0) != 0:
        raise ValueError("Valhalla reports unsuccessful trip status")
    summary = trip.get("summary")
    if not isinstance(summary, dict):
        raise ValueError("Valhalla route summary absent")
    metres = summary.get("length", 0) * 1000 if isinstance(summary.get("length"), (int, float)) else 0
    seconds = summary.get("time", 0)
    if not math.isfinite(metres) or not 100 <= metres <= 1_000_000:
        raise ValueError("Valhalla route distance is missing or implausible")
    if not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or not 1 < seconds < 250_000:
        raise ValueError("Valhalla route time missing or implausible")
    legs = trip.get("legs")
    if not isinstance(legs, list) or len(legs) != 1:
        raise ValueError("Valhalla route must have one connected leg")
    leg = legs[0]
    if not isinstance(leg, dict) or not isinstance(leg.get("shape"), str) or len(leg["shape"]) < 10:
        raise ValueError("Valhalla route geometry absent")
    manoeuvres = leg.get("maneuvers")
    if not isinstance(manoeuvres, list) or len(manoeuvres) < 2:
        raise ValueError("Valhalla returned no turn-by-turn manoeuvres")
    last = -1
    for index, manoeuvre in enumerate(manoeuvres):
        if not isinstance(manoeuvre, dict):
            raise ValueError("Malformed manoeuvre")
        a = manoeuvre.get("begin_shape_index")
        b = manoeuvre.get("end_shape_index")
        if not isinstance(a, int) or not isinstance(b, int) or a < last or b < a:
            raise ValueError("Unordered route manoeuvre shape indices")
        text = manoeuvre.get("instruction")
        if not isinstance(text, str) or not text.strip() or len(text) > 300:
            raise ValueError("Missing or oversized manoeuvre instruction")
        last = a
        if index == len(manoeuvres) - 1 and manoeuvre.get("type") not in (4, 5, 6):
            raise ValueError("Final Valhalla manoeuvre is not arrival")
    return {"distance_km": round(metres / 1000, 2), "duration_minutes": round(seconds / 60, 1),
            "manoeuvres": len(manoeuvres)}


def run_probes(image, config, graph, out, runner=subprocess.run):
    config = Path(config).resolve()
    graph = Path(graph).resolve()
    out = Path(out)
    if not config.is_file() or graph.stat().st_size < 1024:
        raise ValueError("Missing Valhalla config or complete tile extract")
    root = Path.cwd().resolve()
    try:
        relative = config.relative_to(root)
    except ValueError as error:
        raise ValueError("Valhalla config must be inside the mounted workspace") from error
    report = {"engine": image, "status": "EXPERIMENTAL_NOT_ROAD_VALIDATED",
              "samples": [], "failures": []}
    for name, start, destination in SAMPLES:
        command = ["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
                   "-v", f"{root}:/work", "-w", "/work", image,
                   "valhalla_service", f"/work/{relative.as_posix()}", "route",
                   json.dumps(route_request(start, destination), separators=(",", ":"))]
        try:
            result = runner(command, check=True, capture_output=True, text=True, timeout=300)
            if len(result.stdout) > 8_000_000:
                raise ValueError("Oversized route response")
            parsed = validate_response(json.loads(result.stdout))
            report["samples"].append({"name": name, "passed": True, **parsed})
        except (ValueError, json.JSONDecodeError, subprocess.SubprocessError, OSError) as error:
            report["samples"].append({"name": name, "passed": False, "error": str(error)[:400]})
            report["failures"].append(name)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    if report["failures"]:
        raise RuntimeError("Valhalla UK route samples FAILED: " + ", ".join(report["failures"]))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--graph", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = run_probes(args.image, args.config, args.graph, args.report)
    except (RuntimeError, ValueError, OSError) as error:
        print("FAIL:", error, file=sys.stderr)
        return 2
    print("PASS:", len(result["samples"]), "actual UK Valhalla journeys and manoeuvres. NOT ROAD VALIDATED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
