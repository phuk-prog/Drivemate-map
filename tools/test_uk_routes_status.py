"""No-network checks for source AND importer identity used to trigger UK builds."""
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import uk_routes_status as status

TAG="uk-map-20261122T084645Z-9013a4487fa6"


class RoutingFreshnessTest(unittest.TestCase):
    def run_for(self, manifest, assets):
        def fake_run(argv, **kwargs):
            if "download" in argv:
                Path(argv[-1], "uk-routing-manifest.json").write_text(json.dumps(manifest))
                return subprocess.CompletedProcess(argv,0,"","")
            if "view" in argv:
                return subprocess.CompletedProcess(argv,0,json.dumps(
                    {"assets":[{"name":item} for item in assets]}),"")
            raise AssertionError(argv)
        return status.needs_routes(TAG,"phuk-prog/Drivemate-map",runner=fake_run)

    def correct(self):
        return {"source_tag":TAG,"format":"drivemate-uk-routing-v1",
                "builder_sha256":status.current_builder_sha(),
                "parts":[{"name":"uk-routing.sqlite.gz.part-000"}]}

    def test_importer_fingerprint_is_authoritative(self):
        manifest=self.correct()
        good={"uk-routing-manifest.json","uk-routing.sqlite.gz.part-000"}
        self.assertFalse(self.run_for(manifest,good))
        manifest["builder_sha256"]="0"*64
        self.assertTrue(self.run_for(manifest,good))

    def test_missing_part_and_old_schema_are_stale(self):
        manifest=self.correct()
        self.assertTrue(self.run_for(manifest,{"uk-routing-manifest.json"}))
        manifest["format"]="wrong"
        self.assertTrue(self.run_for(manifest,{"uk-routing-manifest.json",
                                               "uk-routing.sqlite.gz.part-000"}))
        manifest=self.correct()
        manifest["source_tag"]="uk-map-20261121T211721Z-34a02136f1ac"
        self.assertTrue(self.run_for(manifest,{"uk-routing-manifest.json",
                                               "uk-routing.sqlite.gz.part-000"}))


if __name__=="__main__":
    unittest.main()
