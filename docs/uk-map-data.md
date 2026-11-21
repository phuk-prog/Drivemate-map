# UK-wide map data — GitHub-only temporary storage

Scope: **Map source data only**, not routing, navigation, traffic or UI.

## Current arrangement (GitHub)

**Source:** https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf

The complete UK PBF covers England, Scotland, Wales and Northern Ireland.
It excludes the Isle of Man and Channel Islands. Copyright:
© OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright.

**Workflow:** `.github/workflows/uk-map-github.yml` checks the published
Geofabrik UK map checksum automatically **twice daily at 03:43 and 15:43 UTC**
(GitHub schedules use UTC; executions can be delayed). It also runs when map
pipeline code changes on main, or via manual dispatch. Every check runs the
source unit tests in GitHub Actions. On an actual source change it downloads,
validates and publishes a new full UK PBF Release; if unchanged it does not
redownload gigabytes or create another source Release.

After every source check, `tools/uk_tiles_status.py` compares the UK source
Release with the last successfully published map-tile report on the GitHub
`live` branch, then verifies the dated and compatibility Release assets.
If map tiles are current, the expensive rebuild is skipped. If the source
changed or a previous map build failed/partially published, the source workflow
**calls `.github/workflows/build-tiles.yml` automatically**; that workflow
runs its own tests, boundary/world preflight, full source SHA-256 verification,
Planetiler/PMTiles generation, catalog creation, GitHub Release publication
and `live` branch update. A code change on main also forces a regeneration.
No personal access token, separate cloud storage, manual promotion or external
scheduler is required for the routine GitHub-only process.

**Storage:** GitHub Releases in this private map-data repository, not Git
history, Git LFS or expiring GitHub Actions artifacts. A full UK file is
around 2.1 GB. GitHub limits *each* release asset to under 2 GiB; therefore
the workflow splits the complete byte-identical PBF into parts of at most
850,000,000 bytes, and uploads a manifest and the parts as release assets.
Reassembling the parts in the listed order produces the exact source PBF.
The manifest records SHA-256 for each part and the complete PBF, Geofabrik
MD5, source replication timestamp, licence, attribution and previous tag.

**Publication safety:** A release starts in draft. It becomes published
only after all assets have uploaded and their sizes have been checked. The
previous published UK map remains available if anything fails. A snapshot
whose source MD5 matches the previous version is skipped; no release is
made for unchanged data. The PBF is rejected if it is too small, its
Geofabrik checksum disagrees, its contents cannot be scanned by osmium, or
the source timestamp is too old/far in the future.

Published release tags have the format `uk-map-YYYYMMDDTHHMMSSZ-sha12`.
The latest *UK-specific* published release is the newest tag with that
prefix. Releases unrelated to UK maps and incomplete draft releases
are not considered current.

## UK vector tile regeneration (map display data only)

The `Build offline tiles` reusable workflow is invoked by the UK map
workflow only when source data or map build code has changed, or the last
map-tile publication is stale/incomplete. It uses the latest published
`uk-map-*` Release, reconstructs the source PBF and verifies both per-part
and whole-file SHA-256. Official Geofabrik regional polygons are bundled in
`tiles/boundaries/` and verified before building, avoiding the former 404
failure. Planetiler/PMTiles produces the whole-UK, England, Scotland,
Wales and Northern Ireland map display datasets. These
assets and their build catalog are stored as dated GitHub Releases; the
`live` branch catalog advances only after a successful build.

The updated map display depends on consumers selecting the newest published
tile catalog; the presence of new source files alone does not force an app
or offline device to refresh. **No routing code or navigation system is
changed.** The first full-UK rebuilt map must pass a real integration run
before the update process is considered fully operational.

The existing `tiles-latest` Release is a mutable compatibility alias; the
dated tile releases are the recoverable immutable snapshots. Publishing
multiple tile files to the alias cannot be truly atomic. Consumers should
prefer the versioned catalog that points to dated release assets.

## How to retrieve and reconstruct a map

From a working copy of this private repository with `gh` authenticated:

1. Open the repository's GitHub **Releases** and select the newest
   published release with a tag starting `uk-map-`.
2. Download `manifest.json` and every `uk.osm.pbf.part-NNN` asset.
3. Concatenate parts in the order listed in the manifest's `parts` field
   using binary concatenation.
4. Verify each part's SHA-256 and the reconstructed file's SHA-256 against
   the manifest. Do not use any file when a hash check fails.

The workflow preserves all UK source release snapshots until they are
explicitly deleted. **Storage growth** is approximately 2.3 GB for each
changed daily full UK PBF (roughly 69 GB in 30 days, before map-tile assets).
Two *checks* per day do not double that storage if Geofabrik has not changed
its published snapshot. Configure
retention or migration once the trial establishes reliable daily publication;
avoid allowing an unbounded archive. Large downloads and GitHub Releases
upload limits may also cause retries or failures. GitHub Actions usage in a
private repository may incur billable minutes. Monitor the Actions runs and
release sizes regularly.

This GitHub-only approach deliberately favours simple, verifiable complete
daily source snapshots over a more complex delta-chain archive. It uses more
bandwidth than a persistent incremental service and is **temporary**.
Incremental Geofabrik updates and a persistent cache are worth adopting
for long-term efficiency if/when storage outside GitHub is acceptable.

## Remaining validation before production use

- Verify at least one real 2.1 GB UK PBF downloads and publishes successfully.
- Download and reconstruct one published release; check the whole-file SHA-256.
- Confirm a subsequent run detects the unchanged-source case correctly.
- Inspect both scheduled GitHub Action checks, PBF freshness, new/unchanged
  decisions, successful rebuilds and actual storage growth.
- Verify a no-change run skips the expensive tile rebuild, and a failure
  is retried from the last good UK source on the following check.
- Measure geographic feature completeness independently if required; PBF
  integrity checks do not prove every road is accurately mapped.

## Other data sources — references only, not merged

- **Overture transportation:** monthly open data to compare map completeness;
  https://docs.overturemaps.org/guides/transportation/
- **TomTom Orbis:** request UK raw-data sample, price, bulk rights, update
  frequency, attribution and redistribution terms before any adoption;
  https://docs.tomtom.com/tomtom-orbis-maps/documentation/introduction
- **OS NGD Transport Network:** authoritative but Great Britain only and
  licensing-dependent; https://www.ordnancesurvey.co.uk/products/os-transport-network

**Never silently merge** proprietary or ODbL-derived map datasets without
checking data provenance and licence compatibility.

## Earlier optional S3/diff approach (not enabled)

The separate `.github/workflows/uk-map-sync.yml` is a gated alternative
using external S3-compatible storage and Geofabrik diffs. It requires
storage credentials and the repository variable `UK_MAP_SYNC_ENABLED=true`.
It is **not part of the present GitHub-only solution** and is left disabled.
