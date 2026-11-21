"""Unit tests for twice-daily change detection and automatic tile retry gates."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import uk_tiles_status as status
import uk_github_releases as source

SOURCE = "uk-map-20261120T215948Z-a5cbfca3d537"
TILE = "tiles-20261120T2300Z"


class TileUpdateGateTests(unittest.TestCase):
    def fixtures(self):
        report = {"source_release": SOURCE, "source_sha256": "b" * 64}
        catalog = {"release": TILE, "tilesets": [
            {"file": "england.pmtiles", "bytes": 500},
            {"file": "scotland.pmtiles", "bytes": 200},
            {"file": "wales.pmtiles", "bytes": 100},
            {"file": "northern-ireland.pmtiles", "bytes": 150},
        ]}
        assets = {x["file"]: x["bytes"] for x in catalog["tilesets"]}
        assets.update({"build-report.json": 50, "catalog.json": 40})
        return report, catalog, assets

    def test_missing_live_catalog_requests_rebuild(self):
        with mock.patch.object(status, "get_live_json", return_value=None):
            current, why = status.is_current("owner/repo", SOURCE)
        self.assertFalse(current)
        self.assertIn("Missing", why)

    def test_same_uk_source_with_complete_tile_releases_skips_rebuild(self):
        report, catalog, assets = self.fixtures()
        with mock.patch.object(status, "get_live_json", side_effect=[report, catalog]), \
             mock.patch.object(status, "assets_for", side_effect=[assets, assets]) as fetched:
            current, why = status.is_current("owner/repo", SOURCE)
        self.assertTrue(current, why)
        self.assertEqual(fetched.call_count, 2)

    def test_new_source_requires_tile_rebuild(self):
        report, catalog, _ = self.fixtures()
        with mock.patch.object(status, "get_live_json", side_effect=[report, catalog]), \
             mock.patch.object(status, "assets_for") as release:
            current, why = status.is_current("owner/repo", "uk-map-20261121T040000Z-" + "c" * 12)
        self.assertFalse(current)
        release.assert_not_called()

    def test_failed_partial_alias_is_not_current(self):
        report, catalog, assets = self.fixtures()
        incomplete = dict(assets)
        incomplete.pop("wales.pmtiles")
        with mock.patch.object(status, "get_live_json", side_effect=[report, catalog]), \
             mock.patch.object(status, "assets_for", side_effect=[assets, incomplete]):
            current, why = status.is_current("owner/repo", SOURCE)
        self.assertFalse(current)
        self.assertIn("tiles-latest", why)

    def test_missing_dated_release_is_not_current(self):
        report, catalog, assets = self.fixtures()
        with mock.patch.object(status, "get_live_json", side_effect=[report, catalog]), \
             mock.patch.object(status, "assets_for", side_effect=[None, assets]):
            current, why = status.is_current("owner/repo", SOURCE)
        self.assertFalse(current)

    def test_invalid_source_tag_rejected(self):
        with self.assertRaisesRegex(status.StatusError, "Invalid source tag"):
            status.is_current("owner/repo", "../latest")

    def test_git_hub_output_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "output.txt"
            with mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(output)}, clear=False):
                source.github_outputs(SOURCE, False)
                source.github_outputs(SOURCE, True)
            self.assertEqual(output.read_text().splitlines(), [
                "source_tag=" + SOURCE, "source_changed=false",
                "source_tag=" + SOURCE, "source_changed=true"
            ])
        with self.assertRaises(source.SyncError):
            source.github_outputs("../wrong", False)

    def test_tile_status_outputs_needs_tiles_on_missing_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "job-output.txt"
            with mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(output)}, clear=False), \
                 mock.patch.object(status, "is_current", return_value=(False, "No published tiles")), \
                 mock.patch.object(sys, "argv", ["status.py", "--source-tag", SOURCE, "--repo", "owner/repo"]):
                status.main()
            self.assertEqual(output.read_text(), "needs_tiles=true\n")


if __name__ == "__main__":
    unittest.main()
