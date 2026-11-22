"""Tests of provenance and complete part reconstruction, without downloading UK PBF."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from package_valhalla_tiles import FORMAT, IMAGE, package

ROOT=Path(__file__).resolve().parents[1]

class ValhallaPackageTest(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name)
        self.source=self.root/"source.json"
        self.source.write_text(json.dumps({
            "source_release":"uk-map-20261122T084645Z-9013a4487fa6",
            "source_sha256":"a"*64
        }))
        self.tar=self.root/"tiles.tar"
        self.data=b"Valhalla synthetic routing tiles v1" * 19
        self.tar.write_bytes(self.data)

    def test_parts_reconstruct_exact_tile_bytes_and_manifest(self):
        result=package(self.tar,self.source,self.root/"release",part_bytes=47)
        self.assertEqual(result["format"],FORMAT)
        self.assertEqual(result["valhalla_image"],IMAGE)
        self.assertEqual(result["tile_extract_sha256"],hashlib.sha256(self.data).hexdigest())
        self.assertEqual(b"".join((self.root/"release"/x["name"]).read_bytes()
            for x in result["parts"]),self.data)
        for part in result["parts"]:
            content=(self.root/"release"/part["name"]).read_bytes()
            self.assertEqual(len(content),part["bytes"])
            self.assertEqual(hashlib.sha256(content).hexdigest(),part["sha256"])
            self.assertLessEqual(len(content),47)
        encoded=json.loads((self.root/"release/uk-valhalla-manifest.json").read_text())
        self.assertEqual(encoded,result)
        other=package(self.tar,self.source,self.root/"other",part_bytes=47)
        self.assertEqual(result,other)

    def test_invalid_sources_or_file_rejected_before_publication(self):
        self.source.write_text(json.dumps({"source_release":"latest","source_sha256":"a"*64}))
        with self.assertRaisesRegex(ValueError,"Unpinned"):
            package(self.tar,self.source,self.root/"out")
        self.source.write_text(json.dumps({
            "source_release":"uk-map-20261122T084645Z-9013a4487fa6",
            "source_sha256":"invalid"}))
        with self.assertRaisesRegex(ValueError,"Missing"):
            package(self.tar,self.source,self.root/"out")
        self.tar.unlink()
        with self.assertRaisesRegex(ValueError,"Missing"):
            package(self.tar,self.source,self.root/"out")

    def test_one_time_bootstrap_requires_a_merged_request_on_main(self):
        workflow=(ROOT/".github/workflows/build-uk-valhalla.yml").read_text()
        request=json.loads((ROOT/"requests/uk-valhalla-bootstrap.json").read_text())
        self.assertIn("push:", workflow)
        self.assertIn("branches: [main]", workflow)
        self.assertIn("'requests/uk-valhalla-bootstrap.json'", workflow)
        self.assertIn("github.event_name == 'push'", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("needs: test", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertIn("--draft --prerelease", workflow)
        self.assertIn("verify_valhalla_release.py", workflow)
        self.assertEqual(request["purpose"], "one-time-uk-valhalla-graph-bootstrap")

    def test_part_limit_refused_and_script_syntax(self):
        with self.assertRaisesRegex(ValueError,"Invalid"):
            package(self.tar,self.source,self.root/"out",part_bytes=850_000_001)
        if shutil.which("bash"):
            subprocess.run(["bash","-n",str(ROOT/"tools/build_valhalla_graph.sh")],check=True)
        source=(ROOT/"tools/build_valhalla_graph.sh").read_text()
        self.assertIn(IMAGE,source)
        self.assertIn("sha256",source)
        self.assertIn("valhalla_build_tiles",source)
        self.assertIn("valhalla_build_extract",source)
        self.assertNotIn("ghcr.io/valhalla/valhalla:latest",source)

if __name__=="__main__":
    unittest.main()
