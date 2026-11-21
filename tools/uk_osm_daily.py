#!/usr/bin/env python3
"""Publish a verified UK-wide OpenStreetMap PBF to S3-compatible object storage.

This manages *source map data only*. No routing graph, traffic data, or mobile
app files are generated. Initial sync uses Geofabrik's full UK extract;
subsequent syncs use the extract's Geofabrik replication metadata and diffs.

A new immutable release is uploaded before latest.json is replaced.
An unsuccessful run leaves the last published release untouched.
"""
import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from urllib.request import Request, urlopen

SOURCE_URL = "https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf"
SOURCE_PAGE = "https://download.geofabrik.de/europe/united-kingdom.html"
REPLICATION_MARKER = "united-kingdom-updates"
ATTRIBUTION = "© OpenStreetMap contributors (ODbL 1.0) — https://www.openstreetmap.org/copyright"
MIN_UK_BYTES = 1_000_000_000
MAX_AGE = timedelta(hours=72)
MAX_UPDATE_PASSES = 12
CHUNK = 8 * 1024 * 1024


class SyncError(RuntimeError):
    pass


def utc_now():
    return datetime.now(timezone.utc)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_uri(uri):
    match = re.fullmatch(r"s3://([a-z0-9][a-z0-9.-]{2,62})(?:/([a-zA-Z0-9_./-]+))?", uri or "")
    if not match or ".." in (match.group(2) or "").split("/"):
        raise SyncError("UK_MAP_S3_URI must be s3://bucket/optional-prefix")
    return match.group(1), (match.group(2) or "").strip("/")


def run(args, allowed=(0,)):
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    if result.returncode not in allowed:
        raise SyncError(f"{args[0]} failed (exit {result.returncode}): {result.stderr[-1500:]}")
    return result


class Store:
    """AWS CLI supports AWS S3, Cloudflare R2, and compatible storage."""

    def __init__(self, uri, endpoint=None):
        self.bucket, self.prefix = parse_uri(uri)
        self.base = "s3://" + self.bucket + ("/" + self.prefix if self.prefix else "")
        self.cli = ["aws", "--no-cli-pager"]
        if endpoint:
            if not endpoint.startswith("https://"):
                raise SyncError("UK_MAP_S3_ENDPOINT_URL must be https")
            self.cli += ["--endpoint-url", endpoint]

    def key(self, suffix):
        return "/".join(filter(None, (self.prefix, suffix)))

    def url(self, suffix):
        return self.base + "/" + suffix

    def read(self, suffix, target):
        run(self.cli + ["s3", "cp", self.url(suffix), str(target), "--only-show-errors"])

    def write(self, source, suffix):
        run(self.cli + ["s3", "cp", str(source), self.url(suffix), "--only-show-errors"])

    def present(self, suffix):
        response = subprocess.run(
            self.cli + ["s3api", "head-object", "--bucket", self.bucket,
                        "--key", self.key(suffix)],
            capture_output=True, text=True, check=False,
        )
        if response.returncode == 0:
            return True
        if any(error in response.stderr for error in ("404", "Not Found", "NoSuchKey")):
            return False
        raise SyncError("Unable to check object storage (credentials, bucket, or connectivity): "
                        + response.stderr[-800:])


def check_pbf(path):
    path = Path(path)
    if not path.is_file() or path.stat().st_size < MIN_UK_BYTES:
        raise SyncError("UK PBF absent or unexpectedly small; refusing to publish")
    # -e reads through the file, not just its header.
    info = run(["osmium", "fileinfo", "-e", "-j", str(path)])
    try:
        doc = json.loads(info.stdout)
        options = doc["header"]["option"]
        server = options["osmosis_replication_base_url"]
        raw_time = options["osmosis_replication_timestamp"]
        timestamp = datetime.fromisoformat(raw_time.replace("Z", "+00:00"))
    except (ValueError, TypeError, KeyError) as error:
        raise SyncError(f"Missing or invalid Geofabrik replication metadata: {error}") from error
    if REPLICATION_MARKER not in server or not server.startswith("https://download.geofabrik.de/"):
        raise SyncError("Unexpected replication source (must be the UK Geofabrik feed)")
    if timestamp.tzinfo is None:
        raise SyncError("Replication timestamp has no time zone")
    age = utc_now() - timestamp
    if age > MAX_AGE or age < -timedelta(hours=2):
        raise SyncError(f"Map source replication timestamp is stale or in the future: {raw_time}")
    return timestamp.astimezone(timezone.utc).isoformat()


def fetch_baseline(target):
    target = Path(target)
    for attempt in range(1, 4):
        target.unlink(missing_ok=True)
        try:
            request = Request(SOURCE_URL, headers={"User-Agent": "DriveMate-UK-map-sync/1.0"})
            with urlopen(request, timeout=180) as response, target.open("wb") as stream:
                if response.status != 200:
                    raise SyncError(f"Geofabrik returned HTTP {response.status}")
                for block in iter(lambda: response.read(CHUNK), b""):
                    stream.write(block)
            return
        except Exception as problem:
            target.unlink(missing_ok=True)
            if attempt == 3:
                raise SyncError(f"Baseline download failed after three attempts: {problem}") from problem
            time.sleep(attempt * 10)


def read_pointer(store, folder):
    pointer_file = folder / "remote-latest.json"
    store.read("latest.json", pointer_file)
    try:
        pointer = json.loads(pointer_file.read_text())
        sha = pointer["sha256"]
        size = pointer["bytes"]
        key = pointer["object_key"]
        timestamp = pointer["replication_timestamp"]
        if (not re.fullmatch(r"[a-f0-9]{64}", sha) or
                not isinstance(size, int) or size < MIN_UK_BYTES or
                not re.fullmatch(r"releases/[0-9TZ-]+-[a-f0-9]{12}/united-kingdom.osm.pbf", key)):
            raise ValueError("invalid object metadata")
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if pointer["source_url"] != SOURCE_URL or pointer["licence"] != "ODbL-1.0":
            raise ValueError("unexpected data source or licence")
    except (ValueError, TypeError, KeyError) as error:
        raise SyncError(f"Malformed UK map pointer: {error}") from error
    return pointer


def publish(store, pbf, replication_time, previous, folder):
    sha = digest(pbf)
    if previous and sha == previous["sha256"]:
        print("No content changes; retaining existing release", previous["version"])
        return False
    now = utc_now()
    version = now.strftime("%Y%m%dT%H%M%SZ") + "-" + sha[:12]
    prefix = "releases/" + version
    object_key = prefix + "/united-kingdom.osm.pbf"
    manifest = {
        "schema_version": 1,
        "version": version,
        "region": "United Kingdom (England, Scotland, Wales, Northern Ireland)",
        "source_url": SOURCE_URL,
        "source_information": SOURCE_PAGE,
        "replication_timestamp": replication_time,
        "published_utc": now.isoformat(),
        "bytes": Path(pbf).stat().st_size,
        "sha256": sha,
        "object_key": object_key,
        "licence": "ODbL-1.0",
        "attribution": ATTRIBUTION,
        "previous_version": previous["version"] if previous else None,
    }
    manifest_path = folder / "release-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    # Upload immutable data and its provenance first. latest.json is the commit point.
    store.write(pbf, object_key)
    store.write(manifest_path, prefix + "/manifest.json")
    store.write(manifest_path, "latest.json")
    print("PUBLISHED UK map:", version, "SHA-256:", sha)
    print("Map source timestamp:", replication_time)
    return True


def update_extract(staged):
    for number in range(MAX_UPDATE_PASSES):
        result = run(["pyosmium-up-to-date", str(staged)], allowed=(0, 1))
        if result.returncode == 0:
            return
        print("Further Geofabrik diffs available, applying next batch", number + 2)
    raise SyncError("Too many replication passes; source may require a fresh baseline")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("bootstrap", "update"))
    args = parser.parse_args()
    uri = os.environ.get("UK_MAP_S3_URI", "")
    endpoint = os.environ.get("UK_MAP_S3_ENDPOINT_URL") or None
    for tool in ("aws", "osmium", "pyosmium-up-to-date"):
        if not shutil.which(tool):
            raise SyncError(f"Missing required tool: {tool}")
    if not os.environ.get("AWS_ACCESS_KEY_ID") or not os.environ.get("AWS_SECRET_ACCESS_KEY"):
        raise SyncError("Object storage credentials are not configured")
    store = Store(uri, endpoint)
    root = Path(os.environ.get("UK_MAP_CACHE_DIR", "/tmp/drivemate-uk-map")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    # Persistent cache on a dedicated runner is preferred; never use the Git checkout.
    if shutil.disk_usage(root).free < 8_000_000_000:
        raise SyncError("At least 8 GB free disk space is required for a UK map sync")
    staged = root / "next-uk.osm.pbf"
    cached = root / "cached-uk.osm.pbf"
    try:
        if args.mode == "bootstrap":
            if store.present("latest.json"):
                raise SyncError("UK map already bootstrapped; use update, not bootstrap")
            fetch_baseline(staged)
            stamp = check_pbf(staged)
            publish(store, staged, stamp, None, root)
            os.replace(staged, cached)
        else:
            previous = read_pointer(store, root)
            if not cached.is_file() or cached.stat().st_size != previous["bytes"] or digest(cached) != previous["sha256"]:
                store.read(previous["object_key"], cached)
                if digest(cached) != previous["sha256"]:
                    raise SyncError("Downloaded baseline does not match published SHA-256")
            shutil.copyfile(cached, staged)
            update_extract(staged)
            stamp = check_pbf(staged)
            if datetime.fromisoformat(stamp) < datetime.fromisoformat(previous["replication_timestamp"]):
                raise SyncError("Source replication time regressed")
            changed = publish(store, staged, stamp, previous, root)
            if changed:
                os.replace(staged, cached)
    finally:
        staged.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except (SyncError, OSError) as exc:
        print("UK map sync FAILED:", exc, file=sys.stderr)
        sys.exit(2)
