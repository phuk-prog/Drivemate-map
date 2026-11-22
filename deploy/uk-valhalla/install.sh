#!/usr/bin/env bash
# Install a published full UK Valhalla graph, never partial or unaudited tiles.
# Requires gh, python3, docker; run on a machine with plenty of free storage.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY="$ROOT/deploy/uk-valhalla"
IMAGE="ghcr.io/valhalla/valhalla:3.8.3@sha256:f648b73740c36006ba5719dfc5ff30ceda1bf5152f4d7d90c214d7e4155374e4"
TAG="${1:-}"
if [[ ! "$TAG" =~ ^valhalla-[A-Za-z0-9-]+$ ]]; then
  echo "Supply the exact verified, published valhalla-* GitHub Release tag" >&2
  exit 2
fi
for binary in gh python3 docker; do
  command -v "$binary" >/dev/null || { echo "Missing $binary" >&2; exit 2; }
done
mkdir -p "$DEPLOY/data"
TARGET="$DEPLOY/data/$TAG"
mkdir -p "$TARGET"
# Download everything into a separate staging location; no HTTP origin, stale
# cached file or interrupted download is trusted without manifest verification.
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
gh release download "$TAG" --repo phuk-prog/Drivemate-map \
  --pattern 'uk-valhalla-*' --dir "$TEMP"
python3 "$ROOT/tools/restore_uk_valhalla.py" \
  --manifest "$TEMP/uk-valhalla-manifest.json" --parts "$TEMP" \
  --target "$TARGET/tiles.tar"
docker pull "$IMAGE"
# The exact builder image is the runtime image: no silent graph-format upgrade.
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --volume "$TARGET:/data:rw" --workdir /data "$IMAGE" \
  valhalla_build_config --mjolnir-tile-dir "/data/tiles" \
  --mjolnir-tile-extract "/data/tiles.tar" > "$TARGET/valhalla.json.incomplete"
python3 - "$TARGET/valhalla.json.incomplete" <<'PY'
import json,sys
from pathlib import Path
config=json.loads(Path(sys.argv[1]).read_text())
mj=config.get("mjolnir",{})
if mj.get("tile_extract")!="/data/tiles.tar":
    raise SystemExit("Valhalla runtime config not pointing to the verified UK graph")
print("Runtime config validated; NOT ROAD VALIDATED")
PY
mv "$TARGET/valhalla.json.incomplete" "$TARGET/valhalla.json"
chmod 0444 "$TARGET/tiles.tar" "$TARGET/valhalla.json"
# Switch only after full verification; an old working copy remains untouched
# on download/verification failure. Restart the service after switching.
ln -sfn "$TAG" "$DEPLOY/data/current.pending"
mv -Tf "$DEPLOY/data/current.pending" "$DEPLOY/data/current"
echo "Verified UK graph prepared in $TARGET"
echo "To run: docker compose -f $DEPLOY/compose.yaml up -d"
echo "Bind is localhost:8002 only; public Android access REQUIRES a separate secure HTTPS gateway."
