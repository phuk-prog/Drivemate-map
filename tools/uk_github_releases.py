#!/usr/bin/env python3
"""Sync a verified *source* UK OSM PBF into private GitHub Release assets.

No routing, map rendering, application features, or traffic systems.
A release is created as a draft, uploaded, size-checked, then published.
A failed upload never replaces the latest published UK source snapshot.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from urllib.request import Request, urlopen

PBF_URL = "https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf"
MD5_URL = PBF_URL + ".md5"
MIN_BYTES = 1_000_000_000
PART_BYTES = 850_000_000  # safely below the 2 GiB GitHub Release asset cap
MAX_AGE = timedelta(hours=72)
ATTRIBUTION = "© OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright"
TAG_PATTERN = re.compile(r"^uk-map-\d{8}T\d{6}Z-[a-f0-9]{12}$")


class SyncError(RuntimeError):
    pass


def run(args):
    answer = subprocess.run(args, capture_output=True, text=True, check=False)
    if answer.returncode:
        raise SyncError(f"{args[0]} failed ({answer.returncode}): {answer.stderr[-1200:]}")
    return answer.stdout


def now_utc():
    return datetime.now(timezone.utc)


def checksum(path, algorithm="sha256"):
    h = hashlib.new(algorithm)
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def get_geofabrik_md5():
    """Retry transient checksum endpoint failures, not malformed upstream data."""
    req = Request(MD5_URL, headers={"User-Agent": "DriveMate-map-data/1.0"})
    for attempt in range(3):
        try:
            with urlopen(req, timeout=60) as response:
                raw = response.read(256).decode("ascii")
            break
        except (OSError, TimeoutError) as exc:
            if attempt == 2:
                raise SyncError(
                    f"Geofabrik checksum endpoint unavailable after 3 attempts: {exc}"
                ) from exc
            # A short bounded retry also handles temporary runner DNS/routing outages.
            time.sleep(5 * (attempt + 1))
    found = re.search(r"\b([a-fA-F0-9]{32})\b", raw)
    if not found:
        raise SyncError("Geofabrik did not provide a valid source MD5")
    return found.group(1).lower()


def list_uk_releases(repo):
    raw = run(["gh", "release", "list", "--repo", repo, "--limit", "100",
               "--json", "tagName,isDraft,publishedAt"])
    try:
        releases = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SyncError("GitHub release list returned invalid JSON") from exc
    matches = [r for r in releases if not r["isDraft"] and TAG_PATTERN.fullmatch(r["tagName"])]
    return sorted(matches, key=lambda r: r["tagName"], reverse=True)


def existing_manifest(repo, folder):
    published = list_uk_releases(repo)
    if not published:
        return None
    tag = published[0]["tagName"]
    run(["gh", "release", "download", tag, "--repo", repo,
         "--pattern", "manifest.json", "--dir", str(folder)])
    try:
        doc = json.loads((folder / "manifest.json").read_text(encoding="utf8"))
        if doc["tag"] != tag or doc["source_url"] != PBF_URL:
            raise ValueError("unexpected release or source")
        if not re.fullmatch(r"[a-f0-9]{32}", doc["source_md5"]):
            raise ValueError("missing MD5")
        if not re.fullmatch(r"[a-f0-9]{64}", doc["sha256"]):
            raise ValueError("missing SHA-256")
    except (ValueError, KeyError, TypeError) as exc:
        raise SyncError("Existing UK map release manifest is invalid") from exc
    return doc


def download_source(destination):
    for attempt in range(3):
        Path(destination).unlink(missing_ok=True)
        try:
            request = Request(PBF_URL, headers={"User-Agent": "DriveMate-map-data/1.0"})
            with urlopen(request, timeout=180) as response, Path(destination).open("wb") as output:
                if response.status != 200:
                    raise SyncError(f"Unexpected response {response.status}")
                for block in iter(lambda: response.read(8 * 1024 * 1024), b""):
                    output.write(block)
            if Path(destination).stat().st_size < MIN_BYTES:
                raise SyncError("Full UK map download unexpectedly small")
            return
        except (OSError, TimeoutError, SyncError) as exc:
            Path(destination).unlink(missing_ok=True)
            if attempt == 2:
                raise SyncError(f"Geofabrik download repeatedly failed: {exc}") from exc
            time.sleep(10 * (attempt + 1))


def validate_source(path, expected_md5):
    path = Path(path)
    if path.stat().st_size < MIN_BYTES:
        raise SyncError("Map too small to be a complete UK source extract")
    actual_md5 = checksum(path, "md5")
    if actual_md5 != expected_md5:
        raise SyncError("Geofabrik MD5 mismatch, aborting publication")
    try:
        detail = json.loads(run(["osmium", "fileinfo", "-e", "-j", str(path)]))
        options = detail["header"]["option"]
        timestamp = datetime.fromisoformat(options["osmosis_replication_timestamp"].replace("Z", "+00:00"))
    except (KeyError, TypeError, json.JSONDecodeError, ValueError) as exc:
        raise SyncError(f"Invalid PBF or missing Geofabrik timestamp: {exc}") from exc
    if timestamp.tzinfo is None:
        raise SyncError("PBF source timestamp must be timezone-aware")
    age = now_utc() - timestamp
    if age < -timedelta(hours=2) or age > MAX_AGE:
        raise SyncError("PBF source timestamp is suspicious or too old: " + timestamp.isoformat())
    return timestamp.astimezone(timezone.utc).isoformat()


def split_source(pbf, output_directory, part_bytes=PART_BYTES):
    if part_bytes >= (2 * 1024 ** 3) or part_bytes <= 0:
        raise SyncError("Part size must be strictly below 2 GiB")
    parts = []
    with Path(pbf).open("rb") as stream:
        index = 0
        while True:
            piece = output_directory / f"uk.osm.pbf.part-{index:03}"
            length = 0
            h = hashlib.sha256()
            with piece.open("wb") as out:
                while length < part_bytes:
                    data = stream.read(min(8 * 1024 * 1024, part_bytes - length))
                    if not data:
                        break
                    out.write(data)
                    h.update(data)
                    length += len(data)
            if not length:
                piece.unlink(missing_ok=True)
                break
            parts.append({"name": piece.name, "bytes": length, "sha256": h.hexdigest()})
            index += 1
    if not parts:
        raise SyncError("No map parts produced")
    return parts


def verify_uploaded_assets(repo, tag, manifest):
    details = json.loads(run(["gh", "release", "view", tag, "--repo", repo, "--json", "assets,isDraft"]))
    if not details["isDraft"]:
        raise SyncError("Release was published before validation")
    observed = {item["name"]: item["size"] for item in details["assets"]}
    expected = {"manifest.json": (Path(manifest["_local_manifest"]).stat().st_size)}
    expected.update({p["name"]: p["bytes"] for p in manifest["parts"]})
    if observed != expected:
        raise SyncError(f"Release assets differ from manifest: {observed} vs {expected}")


def publish(repo, previous, pbf, source_md5, source_timestamp, folder):
    sha = checksum(pbf)
    if previous and sha == previous["sha256"]:
        print("No change in full UK source contents; skipping duplicate release")
        return False
    tag = "uk-map-" + now_utc().strftime("%Y%m%dT%H%M%SZ") + "-" + sha[:12]
    parts = split_source(pbf, folder)
    manifest = {
        "schema_version": 1,
        "tag": tag,
        "source_url": PBF_URL,
        "source_md5": source_md5,
        "source_replication_timestamp": source_timestamp,
        "created_utc": now_utc().isoformat(),
        "region": "United Kingdom: England, Scotland, Wales, Northern Ireland",
        "bytes": Path(pbf).stat().st_size,
        "sha256": sha,
        "parts": parts,
        "previous_tag": previous["tag"] if previous else None,
        "licence": "ODbL-1.0",
        "attribution": ATTRIBUTION,
        "reassembly": "Concatenate the named parts in the manifest order; verify SHA-256 before use.",
    }
    manifest_path = folder / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf8")
    notes = folder / "release-notes.md"
    notes.write_text(
        "# UK source map data\n\n"
        "Full Geofabrik OpenStreetMap UK PBF (not app binaries).\n"
        "Download manifest.json and all listed parts, concatenate in manifest order, "
        "then check the resulting SHA-256.\n\n"
        f"Source replication timestamp: {source_timestamp}\n\n"
        f"Attribution: {ATTRIBUTION}\n"
    )
    run(["gh", "release", "create", tag, "--repo", repo, "--draft",
         "--title", "UK OSM map source " + tag, "--notes-file", str(notes)])
    files = [str(folder / part["name"]) for part in parts]
    run(["gh", "release", "upload", tag, "--repo", repo, str(manifest_path), *files])
    verify_uploaded_assets(repo, tag, {**manifest, "_local_manifest": str(manifest_path)})
    run(["gh", "release", "edit", tag, "--repo", repo, "--draft=false"])
    print("Published immutable UK map Release:", tag, "SHA-256:", sha)
    return tag


def github_outputs(source_tag, changed):
    """Only a fully published release may advance the GitHub Actions outputs."""
    if not TAG_PATTERN.fullmatch(source_tag):
        raise SyncError("Invalid published UK source release tag")
    if path := os.environ.get("GITHUB_OUTPUT"):
        with open(path, "a", encoding="utf8") as stream:
            stream.write("source_tag=" + source_tag + "\n")
            stream.write("source_changed=" + ("true" if changed else "false") + "\n")


def main():
    repo = os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY")
    if not repo or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise SyncError("GH_REPO or GITHUB_REPOSITORY must identify a repository")
    if not os.environ.get("GH_TOKEN"):
        raise SyncError("Missing GH_TOKEN")
    for command in ("gh", "osmium"):
        if not shutil.which(command):
            raise SyncError(f"Missing {command}")
    if shutil.disk_usage(tempfile.gettempdir()).free < 8_000_000_000:
        raise SyncError("Need at least 8 GB free disk for complete UK map and release parts")
    with tempfile.TemporaryDirectory(prefix="drivemate-uk-") as tmp:
        folder = Path(tmp)
        previous = existing_manifest(repo, folder)
        upstream_md5 = get_geofabrik_md5()
        if previous and previous["source_md5"] == upstream_md5:
            print("Geofabrik source unchanged; existing release", previous["tag"])
            github_outputs(previous["tag"], False)
            return
        pbf = folder / "united-kingdom.osm.pbf"
        download_source(pbf)
        timestamp = validate_source(pbf, upstream_md5)
        published_tag = publish(repo, previous, pbf, upstream_md5, timestamp, folder)
        if published_tag:
            github_outputs(published_tag, True)
        elif previous:
            github_outputs(previous["tag"], False)
        else:
            raise SyncError("No UK source release exists after sync")


if __name__ == "__main__":
    try:
        main()
    except (SyncError, OSError, subprocess.SubprocessError) as exc:
        print("UK GitHub map publication FAILED:", exc, file=sys.stderr)
        sys.exit(2)
