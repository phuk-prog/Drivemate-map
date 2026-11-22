#!/usr/bin/env bash
# Candidate UK Valhalla graph build from the SAME checksum-verified Geofabrik PBF
# as the DriveMate map and existing route pipelines.
# Manual full build first: do not put this unmeasured heavy job on daily schedule.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="valhalla-output"
IMAGE="ghcr.io/valhalla/valhalla:3.8.3@sha256:f648b73740c36006ba5719dfc5ff30ceda1bf5152f4d7d90c214d7e4155374e4"
SOURCE="cache/united-kingdom.osm.pbf"
META="cache/source-release.json"
test -s "$SOURCE" || { echo "Restore the verified UK source first" >&2; exit 1; }
test -s "$META" || { echo "Missing verified UK source metadata" >&2; exit 1; }
mkdir -p "$OUT"
python3 - "$SOURCE" "$META" <<'PY'
import hashlib, json, re, sys
source, metadata = sys.argv[1:]
release = json.load(open(metadata))
tag = release.get("source_release", "")
sha = release.get("source_sha256", "")
if not re.fullmatch(r"uk-map-\d{8}T\d{6}Z-[a-f0-9]{12}", tag):
    raise SystemExit("Source tag is not an immutable UK release")
if not re.fullmatch(r"[a-f0-9]{64}", sha):
    raise SystemExit("UK source SHA256 missing")
with open(source, "rb") as stream:
    digest = hashlib.file_digest(stream, "sha256").hexdigest()
if digest != sha:
    raise SystemExit("Verified UK source PBF digest changed")
print("Valhalla input verified:", tag, digest)
PY
docker pull "$IMAGE"
# The exact image digest is pinned. No route data or Valhalla code is copied
# from unknown endpoints; only the pinned source in cache is used.
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work "$IMAGE" \
    valhalla_build_config \
    --mjolnir-tile-dir "/work/$OUT/tiles" \
    --mjolnir-tile-extract "/work/$OUT/tiles.tar" \
    --mjolnir-admin "/work/$OUT/admins.sqlite" \
    --mjolnir-timezone "/work/$OUT/timezones.sqlite" \
    > "$OUT/valhalla.json"
test -s "$OUT/valhalla.json"
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work "$IMAGE" \
    valhalla_build_admins -c "/work/$OUT/valhalla.json" "/work/$SOURCE"
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work "$IMAGE" \
    valhalla_build_tiles -c "/work/$OUT/valhalla.json" "/work/$SOURCE"
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work "$IMAGE" \
    valhalla_build_extract -c "/work/$OUT/valhalla.json"
test -s "$OUT/tiles.tar"
echo "Candidate Valhalla tile extract built; NOT ROAD VALIDATED"
sha256sum "$OUT/tiles.tar"
