import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { FRONTEND_DIR, listSeeds, loadSeedById } from './config.mjs';
import { calculateReverseDeparture } from './engines/reverse-departure.mjs';
import { compareRoutes } from './engines/route-comparator.mjs';
import { generateEstimatedWaves } from './engines/virtual-wave.mjs';
import { getPrimaryRoute, getSegmentMetric } from './engines/path.mjs';
import { resolveSegmentTelemetry, TelemetryStore } from './store/telemetry-store.mjs';
import { getPollingPolicy } from './scheduler.mjs';
import { formatPht } from './time.mjs';
import { projectOntoCorridor, getVehicleArrivals } from './engines/live-vehicles.mjs';
import { LiveVehicleStore } from './store/live-vehicle-store.mjs';
import { getRoadRouteGeometries } from './road-routing.mjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }); }
}

function latestMetricMap(seed, records, at = new Date()) {
  const metrics = new Map();
  const policy = getPollingPolicy(at);
  const staleAfterMs = Math.max(policy.intervalMinutes, 1) * 2 * 60_000;
  for (const segment of seed.segments) {
    const candidates = records.filter((record) => record.segment_id === segment.segment_id && new Date(record.recorded_at) <= at);
    candidates.sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at));
    const latest = candidates[0];
    const isStale = latest && at.getTime() - new Date(latest.recorded_at).getTime() > staleAfterMs;
    if (latest && policy.liveCallsAllowed && !isStale) {
      metrics.set(segment.segment_id, {
        segment_id: segment.segment_id,
        live_duration_sec: Number(latest.live_duration_sec),
        congestion_ratio: Number(latest.congestion_ratio),
        source: latest.source,
        recorded_at: latest.recorded_at
      });
    } else {
      metrics.set(segment.segment_id, resolveSegmentTelemetry(segment, records, at));
    }
  }
  return metrics;
}

function congestionLevel(ratio) {
  return ratio > 1.6 ? 'SEVERE' : ratio >= 1.2 ? 'MODERATE' : 'CLEAR';
}

function reporterAuthToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{32,})$/);
  return match?.[1] || null;
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filename = path.resolve(FRONTEND_DIR, `.${pathname}`);
  if (filename !== FRONTEND_DIR && !filename.startsWith(FRONTEND_DIR + path.sep)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  try {
    if (!(await stat(filename)).isFile()) throw new Error('Not a file');
    const body = await readFile(filename);
    res.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(filename)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': path.basename(filename) === 'index.html' ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff'
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

export function createApiServer({ seedLoader = loadSeedById, listSeedLoader = listSeeds, store = new TelemetryStore(), liveVehicleStore = new LiveVehicleStore() } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { status: 'ok', service: 'byahe30-api' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/corridors') {
        const seeds = await listSeedLoader();
        sendJson(res, 200, { corridors: seeds.filter((seed) => seed.corridor.is_active).map((seed) => seed.corridor) });
        return;
      }
      const vehiclesMatch = url.pathname.match(/^\/api\/v1\/corridors\/([^/]+)\/vehicles$/);
      const vehicleTripStartMatch = url.pathname.match(/^\/api\/v1\/corridors\/([^/]+)\/vehicle-trips$/);
      const vehiclePositionMatch = url.pathname.match(/^\/api\/v1\/corridors\/([^/]+)\/vehicle-trips\/([^/]+)\/position$/);
      const vehicleTripEndMatch = url.pathname.match(/^\/api\/v1\/corridors\/([^/]+)\/vehicle-trips\/([^/]+)\/end$/);

      if (vehiclesMatch && req.method === 'GET') {
        const corridorId = decodeURIComponent(vehiclesMatch[1]);
        let seed;
        try { seed = await seedLoader(corridorId); }
        catch { sendJson(res, 404, { error: `Unknown corridor: ${corridorId}` }); return; }
        if (!seed.corridor.is_active) {
          sendJson(res, 404, { error: `Corridor is inactive: ${corridorId}` });
          return;
        }
        const now = new Date();
        const records = await store.list();
        const metrics = latestMetricMap(seed, records, now);
        const reports = await liveVehicleStore.listActive(corridorId, now);
        const vehicles = reports.map((report) => {
          const route = seed.routes.find((item) => item.route_id === report.route_id);
          if (!route) return null;
          const arrivals = getVehicleArrivals({ seed, route, metrics, progressKm: report.progress_km, direction: report.direction });
          return {
            ...report,
            source: 'phone_location',
            age_seconds: Math.max(0, Math.floor((now.getTime() - new Date(report.last_seen_at).getTime()) / 1000)),
            arrivals,
            next_stop: arrivals[0] || null
          };
        }).filter(Boolean);
        sendJson(res, 200, { corridor_id: corridorId, as_of: now.toISOString(), source: vehicles.length ? 'phone_location' : 'no_live_reports', vehicles });
        return;
      }

      if (vehicleTripStartMatch && req.method === 'POST') {
        const corridorId = decodeURIComponent(vehicleTripStartMatch[1]);
        const body = await readJson(req);
        const reporterType = body.reporter_type ?? 'commuter';
        if (!['commuter', 'driver', 'demo'].includes(reporterType)) {
          sendJson(res, 400, { error: 'reporter_type must be commuter, driver, or demo.' });
          return;
        }
        const requestHost = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
        if (reporterType === 'demo' && (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(requestHost))) {
          sendJson(res, 403, { error: 'Simulated location reports are available only on a local development server.' });
          return;
        }
        let seed;
        try { seed = await seedLoader(corridorId); }
        catch { sendJson(res, 404, { error: `Unknown corridor: ${corridorId}` }); return; }
        if (!seed.corridor.is_active) {
          sendJson(res, 404, { error: `Corridor is inactive: ${corridorId}` });
          return;
        }
        const route = seed.routes.find((item) => item.route_id === body.route_id);
        if (!route) {
          sendJson(res, 400, { error: 'route_id must belong to the selected corridor.' });
          return;
        }
        if (!['van', 'jeepney', 'bus'].includes(body.vehicle_type)) {
          sendJson(res, 400, { error: 'vehicle_type must be van, jeepney, or bus.' });
          return;
        }
        if (!['forward', 'reverse'].includes(body.direction)) {
          sendJson(res, 400, { error: 'direction must be forward or reverse.' });
          return;
        }
        const trip = await liveVehicleStore.start({ corridorId, routeId: route.route_id, vehicleType: body.vehicle_type, direction: body.direction, reporterType });
        sendJson(res, 201, { ...trip, expires_after_seconds: 90, route_name: route.route_short_name });
        return;
      }

      if (vehiclePositionMatch && req.method === 'POST') {
        const corridorId = decodeURIComponent(vehiclePositionMatch[1]);
        let seed;
        try { seed = await seedLoader(corridorId); }
        catch { sendJson(res, 404, { error: `Unknown corridor: ${corridorId}` }); return; }
        const token = reporterAuthToken(req);
        if (!token) { sendJson(res, 401, { error: 'Location-sharing session is missing or expired.' }); return; }
        const body = await readJson(req);
        const latitude = Number(body.latitude);
        const longitude = Number(body.longitude);
        const accuracy = Number(body.accuracy_m);
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
          sendJson(res, 400, { error: 'A valid latitude and longitude are required.' });
          return;
        }
        if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 500) {
          sendJson(res, 422, { error: 'Location accuracy is too low. Wait for a clearer GPS fix and retry.' });
          return;
        }
        const tripId = decodeURIComponent(vehiclePositionMatch[2]);
        const context = await liveVehicleStore.getTripContext(tripId, corridorId, token);
        if (!context) { sendJson(res, 401, { error: 'Location-sharing session is missing or expired.' }); return; }
        const route = seed.routes.find((item) => item.route_id === context.route_id);
        if (!route) { sendJson(res, 422, { error: 'The active trip route is no longer available.' }); return; }
        const roadGeometries = await getRoadRouteGeometries(seed);
        const projection = projectOntoCorridor(seed, latitude, longitude, route, roadGeometries);
        if (!projection) {
          sendJson(res, 422, { error: 'This location is too far from the selected corridor to report.' });
          return;
        }
        const accepted = await liveVehicleStore.update(tripId, corridorId, token, {
          latitude, longitude, accuracy_m: accuracy,
          forward_progress_km: projection.progress_km,
          corridor_distance_km: projection.corridor_distance_km,
          route_distance_m: projection.distance_to_route_m
        });
        if (!accepted) { sendJson(res, 401, { error: 'Location-sharing session is missing or expired.' }); return; }
        sendJson(res, 200, { accepted: true, accuracy_m: accuracy, expires_after_seconds: 90 });
        return;
      }

      if (vehicleTripEndMatch && req.method === 'POST') {
        const token = reporterAuthToken(req);
        if (!token) { sendJson(res, 401, { error: 'Location-sharing session is missing or expired.' }); return; }
        const corridorId = decodeURIComponent(vehicleTripEndMatch[1]);
        const tripId = decodeURIComponent(vehicleTripEndMatch[2]);
        const ended = await liveVehicleStore.end(tripId, corridorId, token);
        if (!ended) { sendJson(res, 404, { error: 'Active location-sharing trip was not found.' }); return; }
        sendJson(res, 200, { ended: true, corridor_id: corridorId });
        return;
      }

      const statusMatch = url.pathname.match(/^\/api\/v1\/corridors\/([^/]+)\/status$/);
      const wavesMatch = url.pathname.match(/^\/api\/v1\/corridors\/([^/]+)\/waves$/);
      if (statusMatch || wavesMatch) {
        const corridorId = decodeURIComponent((statusMatch || wavesMatch)[1]);
        let seed;
        try { seed = await seedLoader(corridorId); }
        catch { sendJson(res, 404, { error: `Unknown corridor: ${corridorId}` }); return; }
        if (!seed.corridor.is_active) {
          sendJson(res, 404, { error: `Corridor is inactive: ${corridorId}` });
          return;
        }
        const now = new Date();
        const records = await store.list();
        const metrics = latestMetricMap(seed, records, now);
        if (statusMatch) {
          const stops = [...seed.stops].sort((a, b) => a.sequence_order - b.sequence_order);
          const etaOffsets = new Map([[stops[0]?.stop_id, 0]]);
          let cumulativeDuration = 0;
          for (const segment of seed.segments) {
            cumulativeDuration += getSegmentMetric(segment, metrics).live_duration_sec;
            etaOffsets.set(segment.to_stop_id, cumulativeDuration);
          }
          const stopsWithEtas = stops.map((stop) => {
            const offsetSec = etaOffsets.get(stop.stop_id) ?? 0;
            const arrivalEstimate = new Date(now.getTime() + offsetSec * 1000);
            return { ...stop, eta_from_origin_sec: offsetSec, eta_from_origin_pht: formatPht(arrivalEstimate) };
          });
          const segments = seed.segments.map((segment) => {
            const metric = getSegmentMetric(segment, metrics);
            const from = stops.find((stop) => stop.stop_id === segment.from_stop_id);
            const to = stops.find((stop) => stop.stop_id === segment.to_stop_id);
            return {
              ...segment,
              from_stop: from.stop_name,
              to_stop: to.stop_name,
              live_duration_sec: metric.live_duration_sec,
              delay_sec: Math.max(0, metric.live_duration_sec - segment.baseline_duration_sec),
              congestion_ratio: metric.congestion_ratio,
              congestion_level: congestionLevel(metric.congestion_ratio),
              source: metric.source,
              last_updated_at: metric.recorded_at
            };
          });
          const sources = new Set(segments.map((item) => item.source));
          const bottlenecks = segments.filter((item) => item.congestion_level !== 'CLEAR');
          const roadGeometries = await getRoadRouteGeometries(seed);
          const features = roadGeometries ? segments.flatMap((segment) => {
            const geometry = roadGeometries.get(segment.segment_id);
            return geometry ? [{
              type: 'Feature',
              geometry,
              properties: { segment_id: segment.segment_id, congestion_ratio: segment.congestion_ratio, congestion_level: segment.congestion_level }
            }] : [];
          }) : [];
          sendJson(res, 200, {
            corridor: seed.corridor,
            route: getPrimaryRoute(seed),
            as_of: now.toISOString(),
            source: sources.size === 1 ? [...sources][0] : 'mixed',
            geometry_quality: features.length === segments.length ? 'osm_road_route' : 'unavailable',
            stops: stopsWithEtas,
            segments,
            bottlenecks,
            shape: { type: 'FeatureCollection', features }
          });
          return;
        }
        const vehicleType = url.searchParams.get('vehicle_type') || 'van';
        if (!['van', 'jeepney', 'bus', 'any'].includes(vehicleType)) {
          sendJson(res, 400, { error: 'vehicle_type must be van, jeepney, bus, or any' });
          return;
        }
        sendJson(res, 200, generateEstimatedWaves({ seed, metrics, at: now, vehicleType }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/plan/reverse-departure') {
        const body = await readJson(req);
        let corridorId = body.corridor_id || process.env.BYAHE30_DEFAULT_CORRIDOR;
        if (!corridorId) corridorId = (await listSeedLoader()).find((seed) => seed.corridor.is_active)?.corridor.id;
        if (!corridorId) {
          sendJson(res, 503, { error: 'No active corridor is configured' });
          return;
        }
        let seed;
        try { seed = await seedLoader(corridorId); }
        catch { sendJson(res, 404, { error: `Unknown corridor: ${corridorId}` }); return; }
        if (!seed.corridor.is_active) {
          sendJson(res, 404, { error: `Corridor is inactive: ${corridorId}` });
          return;
        }
        const required = ['origin_stop_id', 'destination_stop_id', 'target_arrival_time'];
        const missing = required.filter((field) => typeof body[field] !== 'string' || !body[field]);
        if (missing.length) {
          sendJson(res, 400, { error: `Missing required fields: ${missing.join(', ')}` });
          return;
        }
        const vehiclePreference = body.vehicle_preference || 'any';
        if (!['van', 'jeepney', 'bus', 'any'].includes(vehiclePreference)) {
          sendJson(res, 400, { error: 'vehicle_preference must be van, jeepney, bus, or any' });
          return;
        }
        const records = await store.list();
        const metrics = latestMetricMap(seed, records);
        const reverseDeparture = calculateReverseDeparture({
          seed, metrics,
          originStopId: body.origin_stop_id,
          destinationStopId: body.destination_stop_id,
          targetArrivalTime: body.target_arrival_time,
          vehiclePreference
        });
        const comparison = compareRoutes({
          seed, metrics,
          originStopId: body.origin_stop_id,
          destinationStopId: body.destination_stop_id,
          at: new Date(reverseDeparture.leave_home_by),
          vehiclePreference
        });
        sendJson(res, 200, { reverse_departure: reverseDeparture, route_comparison: comparison });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, url);
        return;
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(res, error.statusCode || (error instanceof TypeError ? 400 : 500), { error: error.message || 'Internal server error' });
    }
  });
}
