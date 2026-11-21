"""Offline, fail-closed tests for UK source-data publication."""
import hashlib
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import uk_osm_daily as uk


class UKMapSyncTests(TestCase):
    def test_s3_location_rejects_traversal(self):
        self.assertEqual(uk.parse_uri("s3://map-storage/uk/data"), ("map-storage", "uk/data"))
        for invalid in ("", "https://bucket/prefix", "s3://aa/x", "s3://bucket/../secrets"):
            with self.assertRaises(uk.SyncError):
                uk.parse_uri(invalid)

    def test_sha256_is_stable(self):
        with tempfile.TemporaryDirectory() as tmp:
            sample = Path(tmp) / "sample"
            sample.write_bytes(b"some map bytes")
            self.assertEqual(uk.digest(sample), hashlib.sha256(b"some map bytes").hexdigest())

    @mock.patch.object(uk, "MIN_UK_BYTES", 1)
    def test_replication_source_and_freshness_are_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            sample = Path(tmp) / "sample.pbf"
            sample.write_bytes(b"sample map")
            good = {
                "header": {
                    "option": {
                        "osmosis_replication_base_url": "https://download.geofabrik.de/europe/united-kingdom-updates",
                        "osmosis_replication_timestamp": "2026-11-20T20:00:00Z",
                    }
                }
            }
            with mock.patch.object(uk, "utc_now", return_value=datetime(2026, 11, 20, 21, tzinfo=timezone.utc)), \
                 mock.patch.object(uk, "run", return_value=SimpleNamespace(stdout=json.dumps(good))):
                self.assertIn("2026-11-20", uk.check_pbf(sample))
                good["header"]["option"]["osmosis_replication_base_url"] = "https://planet.openstreetmap.org/replication"
                with mock.patch.object(uk, "run", return_value=SimpleNamespace(stdout=json.dumps(good))):
                    with self.assertRaisesRegex(uk.SyncError, "Unexpected replication source"):
                        uk.check_pbf(sample)
                good["header"]["option"]["osmosis_replication_base_url"] = "https://download.geofabrik.de/europe/united-kingdom-updates"
                good["header"]["option"]["osmosis_replication_timestamp"] = "2026-11-01T20:00:00Z"
                with mock.patch.object(uk, "run", return_value=SimpleNamespace(stdout=json.dumps(good))):
                    with self.assertRaisesRegex(uk.SyncError, "stale"):
                        uk.check_pbf(sample)

    def test_replication_catches_up_all_available_batches(self):
        codes = iter((1, 1, 0))
        def execute(_args, allowed=(0,)):
            self.assertEqual(allowed, (0, 1))
            return SimpleNamespace(returncode=next(codes))
        with mock.patch.object(uk, "run", side_effect=execute) as called:
            uk.update_extract("sample.osm.pbf")
        self.assertEqual(called.call_count, 3)

    def test_replication_aborts_when_it_never_catches_up(self):
        with mock.patch.object(uk, "run", return_value=SimpleNamespace(returncode=1)):
            with self.assertRaisesRegex(uk.SyncError, "Too many"):
                uk.update_extract("sample.osm.pbf")

    def test_published_pointer_is_written_after_data_and_manifest(self):
        class FakeStore:
            def __init__(self):
                self.puts = []
            def write(self, path, key):
                self.puts.append((str(path), key))
        with tempfile.TemporaryDirectory() as tmp:
            pbf = Path(tmp) / "uk.osm.pbf"
            pbf.write_bytes(b"test-data")
            store = FakeStore()
            with mock.patch.object(uk, "utc_now", return_value=datetime(2026, 11, 20, 21, tzinfo=timezone.utc)):
                self.assertTrue(uk.publish(store, pbf, "2026-11-20T20:00:00+00:00", None, Path(tmp)))
            self.assertTrue(store.puts[0][1].endswith("/united-kingdom.osm.pbf"))
            self.assertTrue(store.puts[1][1].endswith("/manifest.json"))
            self.assertEqual(store.puts[2][1], "latest.json")
            pointer = json.loads((Path(tmp) / "release-manifest.json").read_text())
            self.assertEqual(pointer["sha256"], hashlib.sha256(b"test-data").hexdigest())
            previous = {"sha256": pointer["sha256"], "version": pointer["version"]}
            self.assertFalse(uk.publish(store, pbf, "2026-11-20T20:00:00+00:00", previous, Path(tmp)))
            self.assertEqual(len(store.puts), 3)

    def test_pointer_rejects_unexpected_object_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = {
                "sha256": "a" * 64,
                "bytes": 2000000000,
                "object_key": "../../other-data",
                "replication_timestamp": "2026-11-20T20:00:00+00:00",
                "source_url": uk.SOURCE_URL,
                "licence": "ODbL-1.0",
            }
            class FakeStore:
                def read(self, key, target):
                    Path(target).write_text(json.dumps(payload))
            with self.assertRaisesRegex(uk.SyncError, "Malformed"):
                uk.read_pointer(FakeStore(), Path(tmp))

    def test_object_store_access_denied_is_not_treated_as_absent(self):
        store = uk.Store("s3://map-bucket/uk")
        denied = SimpleNamespace(returncode=1, stderr="AccessDenied (403)")
        with mock.patch.object(uk.subprocess, "run", return_value=denied):
            with self.assertRaises(uk.SyncError):
                store.present("latest.json")


if __name__ == "__main__":
    import unittest
    unittest.main()
