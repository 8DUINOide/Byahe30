# Byahe30

Byahe30 is a software-only commute planning starter for the Baao–Pili–Naga–ADNU corridor in Camarines Sur. It combines scheduled headways, checkpoint-to-checkpoint traffic estimates, and a reverse departure planner. It does not require dedicated vehicle GPS trackers or passenger check-ins. Participating operators can optionally share trip location from a phone already in the vehicle.

## Run locally

Requires Node.js 20 or later. No frontend build step or default package install is needed.

```powershell
cd backend
node src/server.mjs
```

Open `http://localhost:3000`. The interactive map uses OpenStreetMap tiles and needs no map token; the built-in corridor schematic remains as a fallback. Routing data uses a separate server-side `MAPBOX_ACCESS_TOKEN` environment variable.

## What is implemented

- Manila-time polling windows: every 5 minutes at peak, every 15 minutes off-peak, and no live routing calls from 21:31 through 05:29.
- A Mapbox Matrix worker for adjacent checkpoint travel times. Provider errors fall back to same-hour telemetry history, then the seeded baseline.
- Reverse departure planning with travel, half-headway wait, an ADNU last-mile buffer, and segment delay warnings.
- Direct-versus-transfer comparisons at configured transfer hubs.
- Scheduled virtual waves interpolated between corridor checkpoints. All markers are labeled as estimates with a confidence window.
- Optional live phone reporting for participating drivers, with per-stop arrival estimates and automatic expiry when reports stop.
- A responsive dashboard with corridor status and the departure planner.
- PostgreSQL/PostGIS migration and seed importer for hosted use.

## OpenStreetMap exploration

The corridor map uses Leaflet with OpenStreetMap raster tiles. The map displays OSM-contributed roads and place labels beneath Byahe30's checkpoint, congestion, estimated-wave, and optional live-phone-report overlays. The corridor connectors and stop coordinates are still approximate seed data; they are not OSM-verified stop positions or a turn-by-turn route. OSM tiles do not contain live bus positions, schedules, traffic speed, or passenger capacity.

Other useful OSM-based services include [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API) for querying mapped objects such as bus stops and [bus-route relations](https://wiki.openstreetmap.org/wiki/Bus_routes), [Nominatim](https://nominatim.org/) for geocoding, and [OSRM](https://project-osrm.org/docs/v5.5.2/api/) for road-route geometry and baseline driving times. These cover different needs: routing times from OSRM are not live traffic estimates, and mapped bus relations do not imply live vehicle tracking. The public Nominatim service has a strict [usage policy](https://operations.osmfoundation.org/policies/nominatim/), including a one-request-per-second maximum and no client-side autocomplete. The [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/) requires attribution, normal caching, and prohibits bulk tile downloads. Review each public service's policy before production use. Visible map attribution links to OpenStreetMap contributors.

## Data and accuracy

The starter seed is in `data/gtfs/baao-naga/seed.json`. Its nodes are approximate map anchors, and its distance, duration, and checkpoint connector geometry are planning estimates. They are not surveyed boarding points or navigation geometry. Validate the locations, headways, and baseline timings with local operators and routing data before using them for time-critical decisions.

Without `DATABASE_URL`, the server stores telemetry in `data/telemetry/logs.jsonl`. Set `DATABASE_URL` to use PostgreSQL instead; then run the migration in `backend/db/migrations/001_initial_schema.sql` and seed the corridor:

```powershell
cd backend
npm install
npm run seed:db
```

`npm install` supplies the optional PostgreSQL driver. For a Supabase project, run the migration in its SQL editor, then set `DATABASE_URL` to the database connection string.

## Driver phone reporting

Set a strong operator-shared access code on the server before enabling the driver form:

```powershell
$env:BYAHE30_DRIVER_ACCESS_CODE = "replace-with-a-long-random-secret"
cd backend
node src/server.mjs
```

The driver opens **Driver: share this trip**, selects direction and vehicle type, enters the access code, and allows phone location. The page sends an update about every 8 seconds while it remains open in the foreground. Use HTTPS in deployment; browser location works on localhost for development, while mobile browsers may pause location in the background. Reports disappear from commuter views after 90 seconds without an update. Ending the trip deletes its active location. Stale sessions are cleaned up after 30 minutes.

With `DATABASE_URL`, active reports use the `live_vehicle_trips` table created by the migration. Without a database, reports live in the Node process and are lost on restart; that mode is suitable for a single-server pilot. The shared access code is a pilot credential; a public production deployment should replace it with individual operator accounts.
## Traffic polling

The worker checks whether its current Manila minute is scheduled. Run it from a cron service or task scheduler every minute; it only requests live data at the configured 5- or 15-minute marks.

```powershell
cd backend
$env:MAPBOX_ACCESS_TOKEN = "your-server-side-token"
npm run poll
```

The `mapbox/driving-traffic` matrix endpoint permits up to 10 coordinates per request; this seed has eight. Keep the routing token on the server. If no token is set or a request fails, the worker records a fallback reading. Optionally set `BYAHE30_WEATHER_MULTIPLIER` to a value from `1` through `2` when a trusted weather integration reports conditions that warrant a delay adjustment. The project does not fetch weather data on its own.

## API

- `GET /api/v1/corridors` — active corridor seed.
- `GET /api/v1/corridors/baao-naga/status` — stop, segment, congestion, and bottleneck data.
- `GET /api/v1/corridors/baao-naga/waves?vehicle_type=van` — current estimated waves.
- `GET /api/v1/corridors/{corridor_id}/vehicles` — fresh phone location reports and per-stop arrival estimates.
- `POST /api/v1/corridors/{corridor_id}/vehicle-trips` — start a driver phone-reporting session.
- `POST /api/v1/corridors/{corridor_id}/vehicle-trips/{trip_id}/position` — update the current phone location.
- `POST /api/v1/corridors/{corridor_id}/vehicle-trips/{trip_id}/end` — stop reporting and remove the active location.
- `POST /api/v1/plan/reverse-departure` — reverse departure and route comparison.

Example request body:

```json
{
  "origin_stop_id": "baao_centro",
  "destination_stop_id": "adnu_main",
  "target_arrival_time": "2026-11-24T07:30",
  "vehicle_preference": "van"
}
```

An offset-free date-time is interpreted as Philippine local time. ISO date-times with an explicit timezone are also accepted.

## Verify

```powershell
cd backend
npm test
```

The tests cover Manila-time polling boundaries, normal departure calculations, a Palestina bottleneck, direct-versus-transfer comparison, estimated wave labeling, same-hour history fallback, API timeout fallback, and zero live calls late at night.
