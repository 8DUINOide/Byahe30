const ROUTE_CACHE_MS = 24 * 60 * 60_000;
const FAILURE_CACHE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

const routeCache = new Map();
const inFlight = new Map();
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function orderedWaypoints(seed) {
  const route = seed.routes.find((item) => item.stop_ids.length === seed.stops.length) || seed.routes[0];
  if (!route) return null;
  const stopById = new Map(seed.stops.map((stop) => [stop.stop_id, stop]));
  const stops = route.stop_ids.map((stopId) => stopById.get(stopId));
  if (stops.length < 2 || stops.some((stop) => !stop)) return null;
  const segments = stops.slice(0, -1).map((stop, index) => seed.segments.find((segment) =>
    segment.from_stop_id === stop.stop_id && segment.to_stop_id === stops[index + 1].stop_id
  ));
  if (segments.some((segment) => !segment)) return null;
  return { route, stops, segments };
}

function throttledFetch(url) {
  const request = requestQueue.then(async () => {
    const delay = Math.max(0, 1_100 - (Date.now() - lastRequestAt));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastRequestAt = Date.now();
    return fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'Byahe30/1.0 (OSM road route geometry)' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  });
  requestQueue = request.catch(() => {});
  return request;
}

function joinStepCoordinates(steps) {
  const coordinates = [];
  for (const step of steps || []) {
    for (const point of step.geometry?.coordinates || []) {
      const previous = coordinates.at(-1);
      if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) coordinates.push(point);
    }
  }
  return coordinates.length >= 2 ? { type: 'LineString', coordinates } : null;
}

export async function getRoadRouteGeometries(seed) {
  const waypoints = orderedWaypoints(seed);
  if (!waypoints) return null;
  const baseUrl = (process.env.BYAHE30_OSRM_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
  const coordinates = waypoints.stops.map((stop) => `${stop.lng},${stop.lat}`).join(';');
  const key = `${baseUrl}|${waypoints.route.route_id}|${coordinates}`;
  const cached = routeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.geometries;
  if (inFlight.has(key)) return inFlight.get(key);

  const request = (async () => {
    const expiresAt = Date.now() + FAILURE_CACHE_MS;
    try {
      const url = `${baseUrl}/route/v1/driving/${coordinates}?overview=false&steps=true&geometries=geojson&continue_straight=true`;
      const response = await throttledFetch(url);
      if (!response.ok) throw new Error(`OSRM returned HTTP ${response.status}`);
      const result = await response.json();
      const legs = result.code === 'Ok' ? result.routes?.[0]?.legs : null;
      if (!legs || legs.length !== waypoints.segments.length) throw new Error('OSRM could not route every corridor segment');

      const geometries = new Map();
      legs.forEach((leg, index) => {
        const geometry = joinStepCoordinates(leg.steps);
        if (!geometry) throw new Error(`OSRM returned no road geometry for ${waypoints.segments[index].segment_id}`);
        geometries.set(waypoints.segments[index].segment_id, geometry);
      });
      routeCache.set(key, { geometries, expiresAt: Date.now() + ROUTE_CACHE_MS });
      return geometries;
    } catch (error) {
      console.warn(`OSRM road geometry unavailable: ${error.message}`);
      routeCache.set(key, { geometries: null, expiresAt });
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, request);
  return request;
}
