#!/usr/bin/env bash
# Build Drivemate's offline vector tiles (CI only; called by build-tiles.yml).
#
#   1. UK vector tiles: Planetiler (pinned jar, SHA-256 checked) with the
#      Shortbread schema on the cached, up-to-date UK .osm.pbf -> PMTiles v3.
#   2. Split into England / Scotland / Wales / Northern Ireland with
#      `pmtiles extract` (pinned binary, SHA-256 checked), each < 2 GiB.
#   3. World outline z0-6: `pmtiles extract --maxzoom=6` of the Protomaps
#      daily planet build.
#   4. Writes $OUT/build-report.json (times, peak memory, sizes) and
#      $OUT/spec.json for tools/tile_catalog.py.
#
# Map data (c) OpenStreetMap contributors, ODbL 1.0.
set -euo pipefail

PLANETILER_VERSION=0.10.2
PLANETILER_SHA256=f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d
PMTILES_VERSION=1.31.2
PMTILES_SHA256=3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f
WATER_URL=https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip
UA="Drivemate-tile-builder/1.0 (offline navigation research)"

CACHE=${CACHE:-cache}
WORK=${WORK:-$PWD/work}
OUT=${OUT:-$PWD/out}
CONFIG=${CONFIG:-tiles/regions.json}
JAVA_HEAP=${JAVA_HEAP:-6g}
mkdir -p "$WORK/bin" "$WORK/sources" "$WORK/tmp" "$OUT"

base_region=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['base_region'])" "$CONFIG")
BASE="$CACHE/$base_region.osm.pbf"
POLY="$CACHE/$base_region.poly"
[ -s "$BASE" ] || { echo "::error::No verified UK source PBF at $BASE: restore source Release first"; exit 1; }
[ -s "$POLY" ] || { echo "::error::No region polygon at $POLY"; exit 1; }

now() { date +%s; }
fetch() { curl -fsSL --retry 3 --retry-delay 10 -A "$UA" -o "$2" "$1"; }
check() { echo "$1  $2" | sha256sum -c -; }
# Runs a command under GNU time; appends "<label> <seconds> <peak_rss_kb>" to timings.
timed() {
  local label=$1; shift
  local t0; t0=$(now)
  /usr/bin/time -v -o "$WORK/time-$label.txt" "$@"
  local rss; rss=$(awk -F: '/Maximum resident set size/ {gsub(/ /,"",$2); print $2}' "$WORK/time-$label.txt")
  echo "$label $(( $(now) - t0 )) $rss" | tee -a "$WORK/timings.txt"
}
: > "$WORK/timings.txt"

echo "::group::Tools"
[ -s "$WORK/bin/planetiler.jar" ] || fetch \
  "https://github.com/onthegomap/planetiler/releases/download/v$PLANETILER_VERSION/planetiler.jar" "$WORK/bin/planetiler.jar"
check "$PLANETILER_SHA256" "$WORK/bin/planetiler.jar"
fetch "https://github.com/protomaps/go-pmtiles/releases/download/v$PMTILES_VERSION/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" \
  "$WORK/bin/pmtiles.tgz"
check "$PMTILES_SHA256" "$WORK/bin/pmtiles.tgz"
tar -xzf "$WORK/bin/pmtiles.tgz" -C "$WORK/bin" pmtiles
PMTILES="$WORK/bin/pmtiles"
java -version 2>&1
"$PMTILES" version || true
echo "::endgroup::"

echo "::group::Inputs"
ls -l "$BASE" "$POLY"
t0=$(now)
fetch "$WATER_URL" "$WORK/sources/water-polygons-split-3857.zip"
echo "water polygons: $(stat -c %s "$WORK/sources/water-polygons-split-3857.zip") bytes in $(( $(now) - t0 ))s"
echo "::endgroup::"

echo "::group::Planetiler (Shortbread) UK build"
UK="$WORK/$base_region.pmtiles"
rm -f "$UK"
maxzoom=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['max_zoom'])" "$CONFIG")
timed planetiler java -Xmx"$JAVA_HEAP" -jar "$WORK/bin/planetiler.jar" shortbread \
  --osm_path="$BASE" --ocean_path="$WORK/sources/water-polygons-split-3857.zip" \
  --polygon="$POLY" --maxzoom="$maxzoom" --storage=mmap --tmpdir="$WORK/tmp" \
  --output="$UK" --force --nodemap-type=sortedtable
rm -rf "$WORK/tmp"
ls -l "$UK"
echo "::endgroup::"

echo "::group::Regional extracts"
# Input geometries were fetched and verified BEFORE the expensive UK build.
python3 - "$CONFIG" "$WORK" <<'PY'
import json, sys
from pathlib import Path
cfg = json.load(open(sys.argv[1])); work = Path(sys.argv[2])
for region in cfg["regions"]:
    if "polygon_file" in region:
        expected = work / (region["name"] + ".geojson")
        if not expected.is_file() or expected.stat().st_size < 50:
            raise SystemExit("Missing preflight-validated GeoJSON: " + str(expected))
PY
python3 -c "import json,sys;[print(r['name'], ','.join(map(str,r['bbox'])) if 'bbox' in r else '-') for r in json.load(open(sys.argv[1]))['regions']]" "$CONFIG" |
while read -r name bbox; do
  if [ "$bbox" = "-" ]; then
    timed "extract-$name" "$PMTILES" extract "$UK" "$OUT/$name.pmtiles" --region="$WORK/$name.geojson"
  else
    timed "extract-$name" "$PMTILES" extract "$UK" "$OUT/$name.pmtiles" --bbox="$bbox"
  fi
  "$PMTILES" verify "$OUT/$name.pmtiles"
done
echo "::endgroup::"

echo "::group::World outline (Protomaps daily planet, z0-6)"
world_maxzoom=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['world']['max_zoom'])" "$CONFIG")
# The world source is probed during preflight, never after the 24-minute UK build.
planet=$(cat "$WORK/world-source.txt")
case "$planet" in
  https://build.protomaps.com/????????.pmtiles) ;;
  *) echo "::error::World source was not preflight-validated"; exit 1 ;;
esac
echo "planet: $planet"
echo "$planet" > "$WORK/world-source.txt"
timed world "$PMTILES" extract "$planet" "$OUT/world-z0-$world_maxzoom.pmtiles" --maxzoom="$world_maxzoom" --download-threads=8
"$PMTILES" verify "$OUT/world-z0-$world_maxzoom.pmtiles"
echo "::endgroup::"

# Publish the whole-UK file too when it fits the release asset limit.
uk_bytes=$(stat -c %s "$UK")
if [ "$uk_bytes" -lt 2147483648 ]; then mv "$UK" "$OUT/$base_region.pmtiles"; fi

echo "::group::Report"
python3 - "$CONFIG" "$WORK" "$OUT" "$uk_bytes" "$PLANETILER_VERSION" "$PLANETILER_SHA256" "$PMTILES_VERSION" "$PMTILES_SHA256" <<'PY'
import json, os, sys, platform, subprocess
sys.path.insert(0, "tools")
import tile_catalog as tc
cfg_path, work, out, uk_bytes, plv, pls, pmv, pms = sys.argv[1:]
cfg = json.load(open(cfg_path))
timings = {}
for line in open(f"{work}/timings.txt"):
    label, secs, rss = line.split()
    timings[label] = {"seconds": int(secs), "peak_rss_mib": round(int(rss) / 1024, 1)}
mem_total = next(int(l.split()[1]) for l in open("/proc/meminfo") if l.startswith("MemTotal"))
base = cfg["base_region"]
world_src = open(f"{work}/world-source.txt").read().strip()
spec, files = [], {}

def osm_time(path):
    m = tc.read_metadata(path)
    return (m.get("planetiler:osm:osmosisreplicationtime") or m.get("planetiler:osm:osmosisreplicationTime"))

uk_path = f"{out}/{base}.pmtiles" if os.path.exists(f"{out}/{base}.pmtiles") else None
names = ([base] if uk_path else []) + [r["name"] for r in cfg["regions"]]
for name in names:
    p = f"{out}/{name}.pmtiles"
    files[name] = os.path.getsize(p)
    spec.append({"path": p, "name": name, "kind": "country" if name == base else "region",
                 "schema": "shortbread", "schema_licence": cfg["schema"]["licence"],
                 "licence": "ODbL-1.0", "attribution": cfg["attribution"],
                 "data_timestamp": osm_time(p),
                 "source": "Planetiler %s Shortbread on %s UK OpenStreetMap PBF (verified Geofabrik GitHub Release)" % (plv, base)})
w = cfg["world"]
wp = f"{out}/world-z0-{w['max_zoom']}.pmtiles"
files["world"] = os.path.getsize(wp)
wm = tc.read_metadata(wp)
spec.append({"path": wp, "name": "world", "kind": "world-outline", "schema": w["schema"]["name"],
             "licence": w["licence"], "attribution": w["attribution"],
             "data_timestamp": wm.get("planetiler:osm:osmosisreplicationtime") or os.path.basename(world_src).split(".")[0],
             "source": world_src})
json.dump(spec, open(f"{out}/spec.json", "w"), indent=2)
report = {
    "runner": {"os": platform.platform(), "cpus": os.cpu_count(), "mem_total_mib": mem_total // 1024},
    "tools": {"planetiler": {"version": plv, "sha256": pls}, "pmtiles": {"version": pmv, "sha256": pms}},
    "schema": cfg["schema"], "uk_full_bytes": int(uk_bytes),
    "uk_full_published": uk_path is not None,
    "timings": timings, "bytes": files, "world_source": world_src,
    "run_url": "%s/%s/actions/runs/%s" % (os.environ.get("GITHUB_SERVER_URL", ""),
                                         os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GITHUB_RUN_ID", "")),
}
# The published release identity links the rendered PMTiles to the UK source.
# This allows the twice-daily updater to skip true no-change runs and retry
# an interrupted publication automatically at the following scheduled check.
source_meta = json.load(open(os.path.join(os.environ.get("CACHE", "cache"), "source-release.json")))
report["source_release"] = source_meta["source_release"]
report["source_sha256"] = source_meta["source_sha256"]
report["source_replication_timestamp"] = source_meta.get("source_replication_timestamp")
json.dump(report, open(f"{out}/build-report.json", "w"), indent=2, sort_keys=True)
print(json.dumps(report, indent=2, sort_keys=True))
over = [n for n, b in files.items() if b >= tc.ASSET_LIMIT]
if over:
    raise SystemExit("over the 2 GiB asset limit: %s" % over)
PY
ls -l "$OUT"
echo "::endgroup::"
