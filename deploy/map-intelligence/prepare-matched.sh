#!/usr/bin/env bash
# Prepare and verify the matching data sets on an owner-approved host. No service is exposed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
GRAPH="${1:?Usage: prepare-matched.sh graph-manifest.json tiles.tar fresh-output-dir}"
ARCHIVE="${2:?Specify graph archive}"
OUT="${3:?Specify fresh output directory}"
for binary in python3 gh; do command -v "$binary" >/dev/null || exit 2; done
export GH_REPO=phuk-prog/Drivemate-map
test -n "${GH_TOKEN:-}" || { echo "Supply authenticated GitHub CLI token via GH_TOKEN" >&2; exit 2; }
mkdir "$OUT"
OUT="$(cd "$OUT" && pwd)"
read -r TAG SHA < <(python3 - "$GRAPH" "$ARCHIVE" <<'PY'
import json,sys
from pathlib import Path
sys.path.insert(0,"tools")
from restore_uk_valhalla import inspect_manifest,sha_file
g=json.loads(Path(sys.argv[1]).read_text());inspect_manifest(g)
a=Path(sys.argv[2])
if a.stat().st_size!=g["tile_extract_bytes"] or sha_file(a)!=g["tile_extract_sha256"]:raise SystemExit("Graph archive mismatch")
print(g["source_tag"],g["source_sha256"])
PY
)
python3 tools/uk_restore_for_tiles.py --dest "$OUT/source" --source-tag "$TAG" --source-sha256 "$SHA"
PBF="$OUT/source/united-kingdom.osm.pbf"
python3 tools/build_map_intelligence.py --source "$PBF" --source-tag "$TAG" --source-sha256 "$SHA" --scope uk --out "$OUT/intelligence"
python3 tools/build_map_v2.py --source "$PBF" --tag "$TAG" --sha "$SHA" --out "$OUT/geometry"
python3 - "$GRAPH" "$ARCHIVE" "$OUT" <<'PY'
import sys
from pathlib import Path
sys.path.insert(0,"tools")
from independent_gateway import load_pair,load_geometry
g,a,out=map(Path,sys.argv[1:])
store,source=load_pair(g,a,out/"intelligence/map-intelligence.sqlite",out/"intelligence/coverage.json")
load_geometry(out/"geometry/map-v2.sqlite",out/"geometry/manifest.json",source)
(out/"VERIFIED-SOURCE.txt").write_text(source["source_sha256"]+"\n")
print("All three datasets match. Not road validated.")
PY
