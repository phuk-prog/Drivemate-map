# DriveMate UK Valhalla routing service (self-hosting candidate)

This is a **deployable but not yet deployed** private UK routing backend.
The UK graph Release
`valhalla-20261122T084645Z-9013a4487fa6-bd370baeb3ecf-run45047350565`
contains 2,885,038,080 bytes of native Valhalla graph tiles built from pinned
Geofabrik/OpenStreetMap data (© OpenStreetMap contributors, ODbL 1.0).
The graph build passed five native UK route and manoeuvre probes, but **has
not been road validated** or proved reliable over public HTTPS.

## Prepare a host

Use a Linux Docker host with comfortably more than 8 GB free for downloads,
part verification and the installed archive, and measure real RAM/CPU usage.
The initial Compose memory limit is an **unmeasured 6 GB ceiling**, not a
published hardware recommendation. Full-UK concurrency, cost, uptime,
security and data-update behaviour require benchmarking.

Install `gh`, Python 3.10+, Docker and Docker Compose; then from the map
repository root:

```sh
bash deploy/uk-valhalla/install.sh valhalla-20261122T084645Z-9013a4487fa6-bd370baeb3ecf-run45047350565
docker compose -f deploy/uk-valhalla/compose.yaml up -d
python3 tools/smoke_valhalla_http.py --endpoint http://127.0.0.1:8002/route
```

The install script downloads **every** release part, rejects missing/unexpected
parts, validates source/build provenance plus each SHA-256 and the combined
archive digest, and only then switches the server-data symlink. It generates
a compatible `valhalla.json` using the **same pinned image** used for the
original graph build. An incomplete graph is never marked installed. The
service reads data through a read-only volume and binds localhost:8002 only.

For updates, use another verified, published immutable graph Release tag and
rerun the installer. Restart the Compose service after the graph switch.
Retain the previous data directory until the new server passes all five real
HTTP route probes. Do not delete a last-known-good graph during update.

## Production operation still required

Expose the route API **only behind a separate HTTPS reverse proxy** with
TLS certificates, abuse/rate limiting, request limits, health monitoring,
controlled logs and authentication or gateway credentials where appropriate.
The raw localhost HTTP API is not an Android production endpoint. Never
embed privileged long-lived server credentials in Android preferences.

Configure the resulting HTTPS `https://your-trusted-host/route` endpoint in
DriveMate **Map options → Services**. Check that Android can calculate and
speak real Valhalla manoeuvres over mobile data and survives GPS loss and
backend failure. A graph Release and this Compose file alone do not start a
public service, and paid hosting must be approved/provisioned separately.

A Photon service and MapLibre style/tile server also need deployment or
appropriately licensed managed endpoints. Full postcodes, traffic, lane
instructions and device-driving acceptance remain separate integrations.

For the independent gateway use the [private service access policy](../../docs/SERVICE-ACCESS.md). Authenticate individual users at a trusted HTTPS reverse proxy and inject the private gateway token only after authorisation. Raw localhost services must not be exposed. The app's account/entitlement system is not yet deployed.
