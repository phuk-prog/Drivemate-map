"""Draft GitHub Release publication must not expose partial UK Valhalla tiles."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from verify_valhalla_release import verify_release, expected_assets


class ValhallaDraftPublicationTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "uk-valhalla-manifest.json"
        self.manifest = {
            "format": "drivemate-valhalla-routing-v1",
            "status": "EXPERIMENTAL_NOT_ROAD_VALIDATED",
            "licence": "ODbL-1.0",
            "source_tag": "uk-map-20261122T084645Z-9013a4487fa6",
            "source_sha256": "a" * 64,
            "builder_sha256": "b" * 64,
            "tile_extract_sha256": "c" * 64,
            "tile_extract_bytes": 6,
            "parts": [
                {"name": "uk-valhalla-tiles.tar.part-000", "bytes": 4,
                 "sha256": "d" * 64},
                {"name": "uk-valhalla-tiles.tar.part-001", "bytes": 2,
                 "sha256": "e" * 64}
            ]
        }
        self.path.write_text(json.dumps(self.manifest) + "\n")
        sizes = expected_assets(self.manifest, self.path)
        self.release = {
            "draft": True, "prerelease": True,
            "assets": [{"name": name, "size": size, "state": "uploaded"}
                       for name, size in sizes.items()]
        }

    def test_pipeline_resolves_drafts_by_id_before_publication(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github/workflows/build-uk-valhalla.yml").read_text()
        request = json.loads((root / "requests/uk-valhalla-bootstrap.json").read_text())
        self.assertIn('release_id_for_tag()', workflow)
        self.assertIn('releases/$release_id', workflow)
        self.assertIn('gh api -X PATCH', workflow)
        self.assertIn('--manifest valhalla-package/uk-valhalla-manifest.json', workflow)
        self.assertIn('run$GITHUB_RUN_ID', workflow)
        self.assertNotIn('releases/tags/$tag', workflow)
        self.assertEqual(request["retry"], 2)

    def test_completed_draft_can_be_promoted(self):
        self.assertEqual(3, verify_release(self.path, self.release))

    def test_missing_part_rejected(self):
        self.release["assets"].pop()
        with self.assertRaisesRegex(ValueError, "mismatch"):
            verify_release(self.path, self.release)

    def test_non_draft_release_rejected(self):
        self.release["draft"] = False
        with self.assertRaisesRegex(ValueError, "non-draft"):
            verify_release(self.path, self.release)

    def test_non_prerelease_rejected(self):
        self.release["prerelease"] = False
        with self.assertRaisesRegex(ValueError, "prerelease"):
            verify_release(self.path, self.release)

    def test_mismatched_size_rejected(self):
        self.release["assets"][1]["size"] += 1
        with self.assertRaisesRegex(ValueError, "mismatch"):
            verify_release(self.path, self.release)

    def test_asset_not_uploaded_rejected(self):
        self.release["assets"][1]["state"] = "new"
        with self.assertRaisesRegex(ValueError, "not fully uploaded"):
            verify_release(self.path, self.release)

    def test_duplicate_asset_rejected(self):
        self.release["assets"].append(dict(self.release["assets"][0]))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            verify_release(self.path, self.release)

    def test_out_of_order_parts_rejected(self):
        self.manifest["parts"][1]["name"] = "uk-valhalla-tiles.tar.part-007"
        self.path.write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError, "out-of-order"):
            verify_release(self.path, self.release)

    def test_missing_source_provenance_rejected(self):
        self.manifest["source_sha256"] = ""
        self.path.write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError, "digest"):
            verify_release(self.path, self.release)

    def test_incomplete_total_rejected(self):
        self.manifest["tile_extract_bytes"] = 7
        self.path.write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError, "total"):
            verify_release(self.path, self.release)


if __name__ == "__main__":
    unittest.main()
