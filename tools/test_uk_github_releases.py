"""Network-free tests for GitHub Release UK PBF snapshots."""
import hashlib
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import uk_github_releases as uk


class GithubUKMapTests(unittest.TestCase):
    def test_uk_release_selection_ignores_unrelated_and_drafts(self):
        entries = [
            {"tagName": "uk-map-20261119T040000Z-" + "a" * 12, "isDraft": False, "publishedAt": "2026-11-19T04:00:00Z"},
            {"tagName": "uk-map-20261120T040000Z-" + "b" * 12, "isDraft": True, "publishedAt": ""},
            {"tagName": "other-release", "isDraft": False, "publishedAt": "2026-11-20T05:00:00Z"},
            {"tagName": "uk-map-20261120T020000Z-" + "c" * 12, "isDraft": False, "publishedAt": "2026-11-20T02:00:00Z"},
        ]
        with mock.patch.object(uk, "run", return_value=json.dumps(entries)):
            got = uk.list_uk_releases("owner/repo")
        self.assertEqual([r["tagName"] for r in got], [entries[3]["tagName"], entries[0]["tagName"]])

    def test_chunk_roundtrip_and_checksums(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            data = b"0123456789" * 13
            source = folder / "uk.osm.pbf"
            source.write_bytes(data)
            parts = uk.split_source(source, folder, part_bytes=40)
            self.assertEqual(len(parts), 4)
            restored = b"".join((folder / p["name"]).read_bytes() for p in parts)
            self.assertEqual(restored, data)
            for part in parts:
                self.assertEqual(uk.checksum(folder / part["name"]), part["sha256"])
            self.assertEqual(uk.checksum(source), hashlib.sha256(data).hexdigest())

    def test_source_validation_checks_checksum_and_age(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "uk.pbf"
            path.write_bytes(b"test")
            stamp = "2026-11-20T20:00:00Z"
            detail = {"header": {"option": {"osmosis_replication_timestamp": stamp}}}
            with mock.patch.object(uk, "MIN_BYTES", 1), \
                 mock.patch.object(uk, "run", return_value=json.dumps(detail)), \
                 mock.patch.object(uk, "now_utc", return_value=datetime(2026, 11, 20, 21, tzinfo=timezone.utc)):
                self.assertEqual(uk.validate_source(path, uk.checksum(path, "md5")),
                                 "2026-11-20T20:00:00+00:00")
                with self.assertRaisesRegex(uk.SyncError, "MD5 mismatch"):
                    uk.validate_source(path, "a" * 32)
                detail["header"]["option"]["osmosis_replication_timestamp"] = "2026-11-01T20:00:00Z"
                with mock.patch.object(uk, "run", return_value=json.dumps(detail)):
                    with self.assertRaisesRegex(uk.SyncError, "too old"):
                        uk.validate_source(path, uk.checksum(path, "md5"))

    def test_no_duplicate_release_on_matching_sha(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            pbf = folder / "uk.pbf"
            pbf.write_bytes(b"abc")
            previous = {"sha256": uk.checksum(pbf), "tag": "uk-map-20261119T040000Z-" + "a" * 12}
            with mock.patch.object(uk, "run") as remote:
                self.assertFalse(uk.publish("owner/repo", previous, pbf, "a" * 32,
                                            "2026-11-20T20:00:00Z", folder))
            remote.assert_not_called()

    def test_release_is_published_only_after_asset_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            pbf = folder / "uk.pbf"
            pbf.write_bytes(b"abcdefghijklmno")
            commands = []
            def fake_run(args):
                commands.append(args)
                return ""
            with mock.patch.object(uk, "run", side_effect=fake_run), \
                 mock.patch.object(uk, "verify_uploaded_assets") as verified, \
                 mock.patch.object(uk, "now_utc", return_value=datetime(2026, 11, 20, 21, tzinfo=timezone.utc)):
                self.assertTrue(uk.publish("owner/repo", None, pbf, "a" * 32,
                                           "2026-11-20T20:00:00Z", folder))
            self.assertEqual([c[2] for c in commands], ["create", "upload", "edit"])
            self.assertIn("--draft", commands[0])
            self.assertIn("--draft=false", commands[-1])
            verified.assert_called_once()
            manifest = json.loads((folder / "manifest.json").read_text())
            self.assertEqual(manifest["parts"][0]["bytes"], 15)
            self.assertEqual(manifest["sha256"], uk.checksum(pbf))

    def test_missing_uploaded_assets_aborts(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            manifest_path = folder / "manifest.json"
            manifest_path.write_text("{}")
            manifest = {"parts": [{"name": "part-000", "bytes": 10}],
                        "_local_manifest": str(manifest_path)}
            with mock.patch.object(uk, "run", return_value=json.dumps(
                {"isDraft": True, "assets": [{"name": "manifest.json", "size": 2}]})):
                with self.assertRaisesRegex(uk.SyncError, "Release assets differ"):
                    uk.verify_uploaded_assets("owner/repo", "tag", manifest)


if __name__ == "__main__":
    unittest.main()
