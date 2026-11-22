"""Map build recipe fingerprint is stable and fails closed on missing inputs."""
import tempfile
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from map_build_fingerprint import RECIPE_FILES, fingerprint


class BuildRecipeFingerprintTest(unittest.TestCase):
    def prepare(self, root):
        for name in RECIPE_FILES:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"fixture\n")
        boundary = root / "tiles/boundaries/england.poly"
        boundary.parent.mkdir(parents=True, exist_ok=True)
        boundary.write_bytes(b"polygon\n")
        return boundary

    def test_determinism_and_changes_to_boundary(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            boundary = self.prepare(root)
            a = fingerprint(root)
            self.assertEqual(a, fingerprint(root))
            boundary.write_bytes(b"new boundary\n")
            self.assertNotEqual(a, fingerprint(root))

    def test_missing_files_are_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            boundary = self.prepare(root)
            (root / "tools/build_tiles.sh").unlink()
            with self.assertRaisesRegex(ValueError, "Missing/symlink"):
                fingerprint(root)
            (root / "tools/build_tiles.sh").write_text("restored")
            boundary.unlink()
            with self.assertRaisesRegex(ValueError, "Missing region"):
                fingerprint(root)


if __name__ == "__main__":
    unittest.main()
