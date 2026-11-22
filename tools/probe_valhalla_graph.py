#!/usr/bin/env python3
"""Fail a candidate UK Valhalla graph without actual regional driving routes.

Runs Valhalla's one-shot route action inside the same pinned container used to
build the graph. These are representative OSM network QA probes, not road
safety, legal-turn or physical-device acceptance evidence.
"""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys

from package_valhalla_tiles import IMAGE

# Multiple nations and two cross-border legs, tested on actual native tiles.
SAMPLES = (
    ("Birmingham–Coventry", (52.486, -1.890), (52.408, -1.510)),
    ("Bristol–Chepstow", (51.454, -2.588), (51.641, -2.675)),
    ("Carlisle–Dumfries", (54.895, -2.938), (55.070, -3.604)),
    ("Edinburgh–Livingston", (55.954, -3.189), (55.883, -3.522)),
    ("Belfast–Lisburn", (54.597, -5.930), (54.516, -6.058)),
)


def check_response(text):
    try:
        result = json.loads(text)
    except (TypeError, ValueError) as e:
        raise ValueError("Valhalla returned malformed JSON") from e
    if not isinstance(result, dict):
        raise ValueError("Valhalla response must be an object")
    trip = result.get("trip")
    if not isinstance(trip, dict):
        raise ValueError("Valhalla failed to return a connected car trip")
    summary = trip.get("summary")
    if not isinstance(summary, dict):
        raise ValueError("Missing trip summary")
    for key in ("time", "length"):
        value = summary.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or \
                not math.isfinite(value) or value <= 0:
            raise ValueError("Invalid Valhalla trip summary " + key)
    legs = trip.get("legs")
    if not isinstance(legs, list) or len(legs) != 1:
        raise ValueError("Expected exactly one car route leg")
    leg = legs[0]
    if not isinstance(leg, dict) or not isinstance(leg.get("shape"), str) or \
            len(leg["shape"]) < 5:
        raise ValueError("Missing encoded route geometry")
    moves = leg.get("maneuvers")
    if not isinstance(moves, list) or len(moves) < 2:
        raise ValueError("Missing authoritative manoeuvre list")
    for move in moves:
        if not isinstance(move, dict) or not isinstance(move.get("type"), int) or \
                not isinstance(move.get("begin_shape_index"), int) or \
                not isinstance(move.get("end_shape_index"), int):
            raise ValueError("Invalid Valhalla manoeuvre metadata")
        if not isinstance(move.get("instruction"), str) or \
                not move["instruction"].strip():
            raise ValueError("Valhalla manoeuvre has no spoken/display instruction")
    return {
        "distance_km": summary["length"],
        "time_seconds": summary["time"],
        "manoeuvres": len(moves),
    }


def request(start, end):
    return json.dumps({
        "locations": [{"lat": start[0], "lon": start[1]},
                      {"lat": end[0], "lon": end[1]}],
        "costing": "auto",
        "directions_options": {"units": "kilometers"},
    }, separators=(",", ":"))


def probe(project_root, config, image=IMAGE, samples=SAMPLES, run=subprocess.run):
    root = Path(project_root).resolve()
    if not root.is_dir() or not (root / config).is_file():
        raise ValueError("Missing built UK Valhalla configuration")
    output = []
    for name, start, end in samples:
        command = [
            "docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
            "-v", str(root) + ":/work", "-w", "/work", image,
            "valhalla_service", "/work/" + str(config), "route",
            request(start, end),
        ]
        try:
            completed = run(command, capture_output=True, text=True, timeout=120,
                            check=False)
            if completed.returncode != 0:
                raise ValueError("Valhalla route process returned code " +
                                 str(completed.returncode) + ": " +
                                 completed.stderr[-450:])
            record = check_response(completed.stdout)
            output.append({"name": name, "passed": True, **record})
        except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
            output.append({"name": name, "passed": False,
                           "reason": str(exc)[:450]})
    return {"scope": "UK routing graph engineering samples",
            "road_validated": False, "image": image, "samples": output,
            "passed": all(x["passed"] for x in output) and len(output) == len(samples)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="valhalla-output/valhalla.json")
    parser.add_argument("--report", default="valhalla-output/route-probes.json")
    args = parser.parse_args(argv)
    root = Path.cwd()
    report = probe(root, args.config)
    target = root / args.report
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
    for item in report["samples"]:
        print(("PASS " if item["passed"] else "FAIL ") + item["name"] +
              (": " + item["reason"] if not item["passed"] else ""))
    if not report["passed"]:
        print("UK Valhalla graph route QA failed; release must remain unpublished.",
              file=sys.stderr)
        return 2
    print("PASS native UK Valhalla route samples; NOT ROAD VALIDATED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
