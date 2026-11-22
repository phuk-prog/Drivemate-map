"""Full UK routing server data must never start from a partial release."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from restore_uk_valhalla import IMAGE, FORMAT, STATUS, inspect_manifest, restore, sha_file


class RestoreValhallaTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = b"Immutable UK Valhalla tiles / " * 101
        first, second = self.data[:1400], self.data[1400:]
        self.parts = []
        for i, payload in enumerate((first, second)):
            name = f"uk-valhalla-tiles.tar.part-{i:03d}"
            (self.root / name).write_bytes(payload)
            self.parts.append({"name":name, "bytes":len(payload),
                               "sha256":hashlib.sha256(payload).hexdigest()})
        self.manifest={
            "format":FORMAT, "status":STATUS, "licence":"ODbL-1.0",
            "source_tag":"uk-map-20261122T084645Z-9013a4487fa6",
            "source_sha256":"a"*64, "builder_sha256":"b"*64,
            "valhalla_image":IMAGE, "tile_extract_file":"tiles.tar",
            "tile_extract_bytes":len(self.data),
            "tile_extract_sha256":hashlib.sha256(self.data).hexdigest(),
            "parts":self.parts,
        }

    def test_full_graph_reconstruction_and_idempotence(self):
        output=self.root/"hosted/tiles.tar"
        self.assertEqual(restore(self.manifest,self.root,output),len(self.data))
        self.assertEqual(output.read_bytes(),self.data)
        self.assertEqual(sha_file(output),self.manifest["tile_extract_sha256"])
        self.assertEqual(restore(self.manifest,self.root,output),len(self.data))
        self.assertFalse(output.with_name("tiles.tar.incomplete").exists())

    def test_missing_or_corrupt_part_cannot_create_or_replace_graph(self):
        output=self.root/"installed/tiles.tar"
        part=self.root/self.parts[1]["name"]
        part.write_bytes(b"z" + part.read_bytes()[1:])
        with self.assertRaisesRegex(ValueError, "Corrupt"):
            restore(self.manifest,self.root,output)
        self.assertFalse(output.exists())
        self.assertFalse(output.with_name("tiles.tar.incomplete").exists())
        output.parent.mkdir(parents=True,exist_ok=True)
        output.write_bytes(b"last-good-data")
        with self.assertRaisesRegex(ValueError, "Existing graph differs"):
            restore(self.manifest,self.root,output)
        self.assertEqual(output.read_bytes(),b"last-good-data")

    def test_unexpected_parts_rejected(self):
        (self.root/"uk-valhalla-tiles.tar.part-999").write_bytes(b"surprise")
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            restore(self.manifest,self.root,self.root/"tiles.tar")

    def test_manifest_does_not_accept_unpinned_or_incomplete_data(self):
        for key, bad in (
            ("source_tag","latest"), ("source_sha256",""),
            ("builder_sha256","invalid"), ("status","ROAD_VALIDATED"),
            ("licence","unknown"), ("valhalla_image","valhalla:latest"),
            ("tile_extract_bytes",len(self.data)+1),
        ):
            bad_manifest=dict(self.manifest)
            bad_manifest[key]=bad
            with self.subTest(key=key), self.assertRaises(ValueError):
                inspect_manifest(bad_manifest)
        wrong=dict(self.manifest)
        wrong["parts"]=list(reversed(self.parts))
        with self.assertRaisesRegex(ValueError,"reordered"):
            inspect_manifest(wrong)

    def test_hosting_is_loopback_readonly_and_requires_explicit_install(self):
        root=Path(__file__).resolve().parents[1]
        compose=(root/"deploy/uk-valhalla/compose.yaml").read_text()
        installer=(root/"deploy/uk-valhalla/install.sh").read_text()
        self.assertIn(IMAGE,compose)
        self.assertIn('"127.0.0.1:8002:8002"',compose)
        self.assertIn("read_only: true",compose)
        self.assertIn("no-new-privileges:true",compose)
        self.assertIn("cap_drop:",compose)
        self.assertIn("--manifest",installer)
        self.assertIn("restore_uk_valhalla.py",installer)
        self.assertIn("valhalla_build_config",installer)
        self.assertIn("mv -Tf",installer)
        self.assertNotIn("docker compose up -d",installer)


if __name__=="__main__":
    unittest.main()
