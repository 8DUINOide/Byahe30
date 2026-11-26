# Byahe30

Byahe30 is a software-only commuter planning and in-transit guidance app for the Baao–Pili–Naga–ADNU corridor in Camarines Sur. It uses OpenStreetMap road context, scheduled service patterns, optional traffic and weather APIs, and browser-only commuter GPS. No vehicle hardware, passenger check-ins, or map tokens are required.

## Run locally

Requires Node.js 20 or later. No frontend build or package install is needed to run the default server.

```powershell
cd backend
node src/server.mjs
```

Open `http://localhost:3000`. The browser tab uses the supplied Byahe30 favicon. Leaflet displays OpenStreetMap tiles with attribution and OSRM road-following geometry. The corridor schematic remains a fallback if the interactive map is unavailable.

## Architecture

### Pre-Trip commute intelligence

- Calculates `leave_home_by` from the requested arrival time, checkpoint travel durations, a terminal wait buffer based on the configured headway, and destination last-mile buffer.
- Compares a direct ride with cut-trips at configured transfer hubs, including bottlenecks in the alternatives.
- Projects clearly labeled **Estimated Waves (±X mins)** along OSM road geometry using traffic-adjusted segment durations and headway schedules.
- Polls optional TomTom Flow and Incident APIs on Manila-time quota-aware intervals: every 5 minutes at 05:30–08:30 and 16:30–19:30, every 15 minutes during the day, and no live traffic or weather calls from 21:31–05:29.
- Fetches hourly Camarines Sur rain conditions from Open-Meteo (no API key) and applies a 1.15×–1.25× travel-time adjustment when rain is active. Failed providers fall back to same-hour history and then the seed baseline.

Set a server-side TomTom key to enable live traffic and incidents:

```powershell
cd backend
$env:BYAHE30_TOMTOM_API_KEY = "your-server-side-key"
npm run poll
```

Run `npm run poll` from a cron service or task scheduler every minute; the worker makes provider calls only when a configured Manila-time polling slot is due. Without the key, weather polling and baseline telemetry still work. Do not expose the key in frontend files.

TomTom is optional. Its [current pricing page](https://docs.tomtom.com/pricing) lists 20,000 free monthly requests for Traffic Flow API Segment Data and 2,500 for Traffic Incidents API Details. With the current schedule and seven segment-flow requests plus one incident request per poll, one continuously polled corridor can use approximately 23,700 flow requests and 3,400 incident requests per 30 days—above those free allowances. Check current terms and usage before enabling a key; paid usage may apply beyond the allowance.

### In-Transit: Track My Ride / Para Alert

The optional **Just Track Me** mode uses `navigator.geolocation.watchPosition()` in the commuter’s browser to identify the nearest checkpoint and estimate remaining time to the selected stop. Choose northbound (Baao → Naga / ADNU) or southbound (Naga → Baao), then choose a drop-off stop and view its local landmarks. A browser audio/vibration alert triggers within 500 m.

The location is held only in the open browser tab and is not posted to Byahe30 or stored by the backend. Browser location generally requires HTTPS (localhost is allowed), permission, and a foreground page. Estimates are advisory; mobile browsers and GPS accuracy vary.

## OpenStreetMap and accuracy

The interactive map uses Leaflet and OpenStreetMap raster tiles; there are no Mapbox dependencies. OSRM requests road geometry for the ordered seed checkpoints and caches successful geometry for 24 hours, with a five-minute failure cache. Set `BYAHE30_OSRM_URL` to a managed or self-hosted OSRM endpoint for hosted use. Public OSRM and OSM tile services are best-effort, have usage policies, and do not provide live traffic or live bus positions. Keep visible OpenStreetMap attribution and review the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) before production use.

The starter data is in `data/gtfs/baao-naga/seed.json`. Coordinates are approximate planning anchors; segment distances, travel baselines, landmarks, and headways need local validation. Every stop includes its canonical northbound direction, landmark notes, and transfer-hub flag. Southbound tracking reverses the configured stop order. Additional corridors such as Iriga or Nabua can be added as `data/gtfs/{corridor_id}/seed.json` without hard-coding town IDs into the engines.

## Online preview

The repository includes a Fly.io app configuration and a GitHub Actions workflow. Create the Fly app once with `fly apps create byahe30-8duinoide` (if that name is unavailable, choose another and update `app` in `fly.toml`). In Fly.io, create an app-scoped deploy token. Add it to GitHub under **Settings → Secrets and variables → Actions** as `FLY_API_TOKEN`. GitHub Actions runs backend tests on pushes to `main` and deploys only after they pass; you can also run the workflow manually from the Actions tab. If the token is not configured yet, tests still run and deployment is skipped.

The preview URL is `https://byahe30-8duinoide.fly.dev` unless you chose a different app name. The Fly machine stops when idle and starts on the next request. Fly's current Free plan includes $5 of monthly usage, then switches to pay-as-you-go and keeps the app running. Usage beyond that credit can be billed, so review Fly's current [pricing](https://fly.io/pricing/) before creating the app.

## Data storage

Without `DATABASE_URL`, telemetry is stored in `data/telemetry/logs.jsonl`. Set `DATABASE_URL` to use PostgreSQL/PostGIS, then apply `backend/db/migrations/001_initial_schema.sql` and seed:

```powershell
cd backend
npm install
npm run seed:db
```

`npm install` supplies the optional PostgreSQL driver. For a Supabase project, run the migration in its SQL editor, then set `DATABASE_URL` to the database connection string. Rerun the migration when upgrading an existing schema so stop direction/landmarks and telemetry weather/incident fields are added.

## API

- `GET /api/v1/corridors` — configured active corridors.
- `GET /api/v1/corridors/{corridor_id}/status` — stop, segment, bottleneck, incident, weather, and OSM geometry data.
- `GET /api/v1/corridors/{corridor_id}/waves?vehicle_type=van` — headway-based estimated waves.
- `POST /api/v1/plan/reverse-departure` — reverse departure and direct-versus-transfer comparison.

Example request (an offset-free date-time is interpreted as Philippine local time):

```json
{
  "corridor_id": "baao-naga",
  "origin_stop_id": "baao_centro",
  "destination_stop_id": "adnu_main",
  "target_arrival_time": "2026-11-24T07:30",
  "vehicle_preference": "van"
}
```

## Verify

```powershell
cd backend
npm test
```

Tests cover Manila-time polling boundaries, weather/traffic fallback, reverse departure, transfer comparison, estimated-wave labeling and geometry, and the zero-call late-night rule.
