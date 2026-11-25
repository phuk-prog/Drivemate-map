# Higher-detail junction map pilot
This feature branch extends the deterministic Wells OSM pilot to native z18, with the same checksum-verified source and existing road geometry. It is not a UK production map and must not be used for driving.

`python3 tools/build_pilot_pack.py --detail-z18` creates a separate PMTiles pack and SHA256 sidecar; `python3 tools/build_pilot_pack.py --detail-z18 --check` verifies reproducibility. The default z12-16 output and production z14 Shortbread catalog remain unchanged. More zoom does not imply lane geometry or more surveyed road detail. Verify tile size, schema compatibility, road coverage, memory and actual junction geometry before proposing a production regional rollout.

The pilot uses the existing roads/buildings/places schema; the Android Shortbread renderer must not ingest it as a Shortbread archive. No routing, lane advice or release catalog changes are made.
