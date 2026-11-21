"""Network-free restoration checks for GitHub-hosted UK source map parts."""
import hashlib
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import uk_restore_for_tiles as uk


class UKSourceRestoreTests(unittest.TestCase):
    def sample(self, folder):
        content = b"abcdefghij"
        names = []
        for index, segment in enumerate((content[:4], content[4:7], content[7:])):
            name = f"uk.osm.pbf.part-{index:03}"
            (folder / name).write_bytes(segment)
            names.append({"name": name, "bytes": len(segment),
                          "sha256": hashlib.sha256(segment).hexdigest()})
        return content, {"source_url": uk.PBF_URL, "licence": "ODbL-1.0",
                         "sha256": hashlib.sha256(content).hexdigest(),
                         "bytes": len(content), "parts": names}

    def test_reassembles_byte_exact_source_and_verifies_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            content, manifest = self.sample(folder)
            with mock.patch.object(uk, "MIN_BYTES", 1):
                uk.reconstruct(manifest, folder, folder / "uk.osm.pbf")
            self.assertEqual((folder / "uk.osm.pbf").read_bytes(), content)

    def test_rejects_unexpected_part_names_and_lengths(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            _, manifest = self.sample(folder)
            with mock.patch.object(uk, "MIN_BYTES", 1):
                manifest["parts"][0]["name"] = "../outside"
                with self.assertRaises(uk.SyncError):
                    uk.validate_manifest(manifest)
                _, manifest = self.sample(folder)
                manifest["parts"][1]["bytes"] = 10
                with self.assertRaises(uk.SyncError):
                    uk.validate_manifest(manifest)

    def test_corrupted_parts_do_not_replace_existing_good_map(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            _, manifest = self.sample(folder)
            target = folder / "uk.osm.pbf"
            target.write_bytes(b"last-good")
            (folder / "uk.osm.pbf.part-002").write_bytes(b"tampered")
            with mock.patch.object(uk, "MIN_BYTES", 1):
                with self.assertRaises(uk.SyncError):
                    uk.reconstruct(manifest, folder, target)
            self.assertEqual(target.read_bytes(), b"last-good")
            self.assertFalse((folder / "uk.osm.pbf.staged").exists())


if __name__ == "__main__":
    unittest.main()
