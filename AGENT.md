# AGENT.md — Byahe30 Engineering & Context Guide

## 1. Project Overview
**Byahe30** is a software-only commuter intelligence and transit corridor tracking platform designed for regional Philippine public transport corridors without hardware GPS trackers. 

Originally built for the **Baao-to-Naga / Ateneo de Naga University (ADNU)** corridor (~30–31 km along Maharlika Highway), Byahe30 models transit flow, live road congestion, headway schedules, and optimal departure windows purely through software APIs, GTFS schemas, and corridor math.

### Core Architecture Philosophy
* **Zero Dedicated Tracker Dependency:** No installed GPS units, vehicle OBD trackers, or mandatory passenger check-ins. An operator-authorized driver's own phone may optionally share location.
* **Corridor & Node Topology:** Treats routes as directed graph polylines with static highway nodes/waypoints.
* **API Telemetry & Headway Logic:** Merges external traffic/routing telemetry with GTFS frequency rules to estimate travel times, corridor bottlenecks, and virtual vehicle progress.
* **Scalable Standard:** Structured to expand effortlessly from Baao–Naga to other Bicol transit corridors (e.g., Iriga–Naga, Nabua–Naga, Legazpi–Naga) simply by declaring new node sets and GTFS feeds.

---

## 2. Tech Stack & Architecture

```
                       ┌──────────────────────────────┐
                       │ External Routing & Traffic   │
                       │  (Mapbox / Google / TomTom)  │
                       └──────────────┬───────────────┘
                                      │ (Cron Polling)
                                      ▼
┌─────────────────┐    ┌──────────────────────────────┐    ┌─────────────────────────┐
│ Client Apps     │◄───┤ Backend & Telemetry Engine   │◄───┤ PostgreSQL + PostGIS    │
│ (React/Native + │    │ (Node.js/TypeScript/FastAPI) │    │ (GTFS Feeds, Nodes,     │
│ Leaflet + OSM)  │    │                              │    │ Segment History, Logs)  │
└─────────────────┘    └──────────────────────────────┘    └─────────────────────────┘
```

* **Frontend:** Lightweight browser dashboard using Leaflet and OpenStreetMap tiles; keep the map provider configurable.
* **Backend:** Node.js (TypeScript) or Python (FastAPI), Serverless Workers / Cron triggers.
* **Database:** PostgreSQL + PostGIS (or Supabase) using GTFS-compliant relational schemas.
* **APIs & Services:** OpenStreetMap tiles and mapped data for static map context; Mapbox Matrix or another traffic provider for road conditions. OSM does not provide live bus positions or traffic telemetry.

---

## 3. Data Models & Schemas

### 3.1 GTFS Base Entities (`routes.txt`, `stops.txt`, `frequencies.txt`, `shapes.txt`)
* **`Corridor` / `Route`**: `route_id`, `route_short_name` ("Byahe30 Baao-Naga"), `origin_stop_id`, `destination_stop_id`, `mode` (`JEEPNEY`, `VAN_UV`, `BUS`).
* **`StopNode`**: `stop_id`, `stop_name` ("Pili Centro"), `location` (`GEOMETRY(Point, 4326)`), `sequence_order`.
* **`RouteShape`**: `shape_id`, `polyline_geom` (`GEOMETRY(LineString, 4326)`), `distance_km`.
* **`HeadwaySchedule`**: `route_id`, `time_window` ("05:30-08:30"), `frequency_minutes` (e.g., 10 mins), `avg_dwell_time_sec`.

### 3.2 Dynamic Telemetry & State
* **`SegmentTelemetry`**:
  * `segment_id` (e.g., `BAAO_ANAYAN`, `PILI_PALESTINA`, `PALESTINA_DELROSARIO`)
  * `current_travel_time_sec`
  * `free_flow_travel_time_sec`
  * `delay_sec`
  * `congestion_level` (`CLEAR`, `MODERATE`, `HEAVY`, `SEVERE`)
  * `last_updated_at`
* **`VirtualVehicleState`**:
  * `trip_id`
  * `route_id`
  * `progress_ratio` ($0.0 \rightarrow 1.0$ along shape polyline)
  * `current_segment_id`
  * `estimated_arrival_destination`

---

## 4. Key Logic & Algorithms

### 4.1 Traffic Polling Engine (Smart Cache & API Saver)
* Poll segment matrix travel times between key highway nodes (e.g., Baao → Anayan → Pili → Palestina → Del Rosario → Naga CBD → ADNU).
* Dynamic Polling Frequency:
  * **Rush Hour (05:30–08:30 & 16:30–19:30):** Every 5 minutes.
  * **Midday (09:00–16:00):** Every 15 minutes.
  * **Off-Peak / Night:** Serving cached historical baselines; zero external API calls.

### 4.2 Virtual Vehicle Spawner & Interpolation
1. **Spawn:** Trigger virtual vehicles at origin terminals based on GTFS `frequencies.txt` rules during operating hours.
2. **Move:** Advance estimated vehicle position along the corridor shape proportional to the **live `SegmentTelemetry` speed** (not static speed).
3. **Drift Protection:** Despawn or clamp virtual markers if total trip duration exceeds $1.8 \times$ maximum segment historical delay.
4. **Visual Labeling:** Always render as an *Estimated Wave / Scheduled Run* (with a confidence radius) rather than claiming hardware GPS precision.

### 4.3 Reverse-Departure Calculator (Target Class Arrival)
Given a desired arrival timestamp at target node (e.g., ADNU at `07:30 AM`):
$$\text{Departure Time} = \text{Target Time} - (\text{Live Highway Travel Time} + \text{Terminal Queue Buffer} + \text{Last-Mile Buffer} + \text{Weather Multiplier})$$

---

## 5. Directory Structure Guidelines

```
byahe30/
├── docs/
│   └── corridors/               # Waypoint definitions for Baao-Naga, Iriga-Naga, etc.
├── src/
│   ├── backend/
│   │   ├── cron/                # Scheduled API polling & GTFS headway workers
│   │   ├── services/            # Traffic matrix, OSM map data, virtual spawner
│   │   ├── db/                  # PostGIS schemas and migrations
│   │   └── api/                 # REST & Realtime WebSocket endpoints
│   ├── frontend/
│   │   ├── components/          # Leaflet map, CorridorHealth, DeparturePlanner
│   │   ├── hooks/               # useCorridorTelemetry, useVirtualVehicles
│   │   └── pages/               # Main commuter dashboard
├── gtfs/                        # Static GTFS CSV feeds (routes, stops, shapes)
└── AGENT.md
```

---

## 6. Coding Standards & Principles for AI Agents

1. **Software-Only Constraint:** Never require dedicated hardware GPS or passenger check-ins. Optional operator-authorized location sharing from a driver's existing phone is allowed; schedule and planning features must remain useful without it.
2. **Deterministic Calculations:** Always compute segment ETAs using explicit node pairs. Never guess travel times without referencing stored segment metrics or API telemetry.
3. **API Budget Awareness:** Ensure all routing API calls go through the caching layer (`SegmentTelemetry`). Never call external routing APIs directly from client components.
4. **Resilient UX:** If external traffic APIs fail or rate-limit, fall back seamlessly to GTFS historical rush-hour profiles and flag the payload as `source: "historical_baseline"`.
5. **Clear Corridor Naming:** Name nodes and segments using standardized slugs (`baao_centro`, `anayan_junction`, `pili_centro`, `palestina`, `del_rosario`, `naga_terminal`, `adnu_main`).

---

## 7. Development Roadmap
- [x] Phase 1: Corridor Topology & GTFS Schema Definition (Baao–Naga).
- [x] Phase 2: Traffic Telemetry Cache Worker & Mapbox Matrix integration.
- [x] Phase 3: Virtual Vehicle Spawner & Polyline Interpolation Engine.
- [x] Phase 4: Reverse-Departure Calculator & Cut-Trip Comparator UI.
- [ ] Phase 5: Multi-Corridor Expansion (Iriga–Naga & Nabua–Naga).

The current code loads corridors from `data/gtfs/{corridor_id}/seed.json`; only Baao–Pili–Naga is seeded. Additional corridor data still needs validation and seeding before Phase 5 is complete.
