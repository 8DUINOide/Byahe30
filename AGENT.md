# Byahe30 Engineering Guide

## Product and constraints

Byahe30 is a software-only commuter intelligence app. It requires no vehicle trackers, OBD devices, passenger check-ins, or operator hardware. Its Baao–Pili–Naga–ADNU corridor is a planning model, not an operator-verified timetable. Do not describe estimated waves as live buses or GPS positions.

The product has two independent modes:

1. **Pre-Trip:** server-side traffic, incident, and weather telemetry plus GTFS-like headways power reverse departure planning, direct-versus-cut-trip comparison, and estimated waves.
2. **In-Transit:** optional browser `navigator.geolocation.watchPosition()` supports nearest-checkpoint guidance, estimated remaining ETA, and a 500 m Para Alert. Keep this location in browser memory only; never send it to the API or persist it.

## Architecture

- **Basemap and road geometry:** Leaflet with OpenStreetMap tiles and attribution. OSRM supplies cached road-following GeoJSON; stop coordinates are approximate planning anchors. Do not add Mapbox SDKs, tokens, endpoints, or assets.
- **Traffic and incidents:** optional server-side TomTom Flow Segment Data and Incident Details APIs. Configure `BYAHE30_TOMTOM_API_KEY`; poll only on `backend/src/scheduler.mjs` time slots. Failures use same-hour telemetry history, then seeded duration.
- **Weather:** Open-Meteo hourly precipitation (no key). Apply 1.15×–1.25× to live segment durations when the current local-hour rain alert is active. Weather data is cached and no traffic/weather requests run from 21:31–05:29 PHT.
- **Backend:** Node.js ES modules, HTTP API, JSONL telemetry by default, optional PostgreSQL/PostGIS via `DATABASE_URL`.
- **Frontend:** static mobile-first HTML/CSS/JavaScript. Browser GPS and notification behavior do not make location API requests.
- **Time:** represent instants as ISO timestamps and format/interpret user-facing schedules in `Asia/Manila` (UTC+8).

## Corridor and stop data

Corridors are dynamically loaded from `data/gtfs/{corridor_id}/seed.json`. The top-level `corridor_id` and `corridor.id` match the directory/API key. Each seed defines its routes, ordered stops, segment baselines, transfer hubs, and headway schedules; adding a corridor should not require hard-coded route IDs in engines or UI.

Stops include `direction` (the canonical northbound sequence), `landmarks` (an array for local context), and `is_transfer_hub`. Southbound browser tracking traverses the same physical stop sequence in reverse. Pili Centro and Naga Central Terminal are transfer hubs in the starter seed. Update the JSON seed, PostgreSQL migration/importer, and relevant tests together when changing stop data.

## Planning and estimated waves

- Reverse departure subtracts live-or-baseline segment duration, a half-headway terminal wait, and any destination last-mile buffer from the requested PHT arrival.
- Direct-versus-cut-trip comparison considers configured transfer hubs and includes segment bottlenecks in each alternative.
- Estimated waves use headway schedules and traffic-adjusted segment durations. When OSRM geometry is available, place markers along that road polyline; otherwise fall back to checkpoint interpolation. Clearly label every marker `Estimated Wave (±X mins)`.
- Late-night planning must continue to work from historical or seeded baselines without external calls.

## Development

- Start locally with `cd backend; node src/server.mjs`.
- Run tests with `cd backend; npm test`.
- Keep API keys server-side; never include them in frontend configuration.
- Preserve OSM attribution and follow public OSM tile, OSRM, and geocoding-service usage policies.
- Keep changes surgical, add focused tests for new behavior, and document provider limits and estimate accuracy.

## Current scope

The active seed covers Baao–Pili–Naga–ADNU. Other towns such as Iriga and Nabua can be added as separate configured corridors after their stop locations, service patterns, and baselines are validated locally.
