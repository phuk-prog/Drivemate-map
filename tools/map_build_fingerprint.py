"""Hash the exact inputs that define UK map tile generation, not its scheduler."""
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RECIPE_FILES = (
    ".github/workflows/build-tiles.yml",
    "tiles/regions.json",
    "tools/build_tiles.sh",
    "tools/preflight_tile_inputs.py",
    "tools/tile_catalog.py",
    "tools/uk_restore_for_tiles.py",
    "tools/map_build_fingerprint.py",
)


def fingerprint(root=ROOT):
    root = Path(root)
    files = set(RECIPE_FILES)
    boundaries = sorted((root / "tiles/boundaries").glob("*.poly"))
    if not boundaries:
        raise ValueError("Missing region boundary polygons")
    files.update(str(p.relative_to(root)) for p in boundaries)
    digest = hashlib.sha256()
    for name in sorted(files):
        p = root / name
        if not p.is_file() or p.is_symlink():
            raise ValueError("Missing/symlink tile recipe input: " + name)
        data = p.read_bytes()
        digest.update(name.encode("utf8") + b"\0" + str(len(data)).encode() + b"\0" + data)
    return digest.hexdigest()


if __name__ == "__main__":
    print(fingerprint())
