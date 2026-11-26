import { getPollingPolicy, isPollingMinute } from '../scheduler.mjs';
import { formatPhtIso, phtParts } from '../time.mjs';
import { resolveSegmentTelemetry } from '../store/telemetry-store.mjs';

const WEATHER_CACHE_MS = 15 * 60_000;
let weatherCache = null;

function midpoint(seed, segment) {
  const from = seed.stops.find((stop) => stop.stop_id === segment.from_stop_id);
  const to = seed.stops.find((stop) => stop.stop_id === segment.to_stop_id);
  if (!from || !to) throw new Error(`Missing stop coordinates for ${segment.segment_id}`);
  return { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
}

export async function fetchTomTomDurations(seed, apiKey, { fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('TomTom Traffic API key is not configured');
  const entries = await Promise.all(seed.segments.map(async (segment) => {
    const point = midpoint(seed, segment);
    const url = new URL('https://api.tomtom.com/traffic/services/4/flowSegmentData/relative0/10/json');
    url.search = new URLSearchParams({ point: `${point.lat},${point.lng}`, key: apiKey }).toString();
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`TomTom Flow API returned HTTP ${response.status}`);
    const body = await response.json();
    const flow = body.flowSegmentData;
    if (!Number.isFinite(flow?.currentSpeed) || !Number.isFinite(flow?.freeFlowSpeed) ||
      flow.currentSpeed < 0 || flow.freeFlowSpeed <= 0) {
      throw new Error(`TomTom returned invalid traffic flow for ${segment.segment_id}`);
    }
    const slowdown = flow.roadClosure || flow.currentSpeed === 0
      ? 3
      : flow.freeFlowSpeed / flow.currentSpeed;
    return [segment.segment_id, Math.max(1, Math.round(segment.baseline_duration_sec * slowdown))];
  }));
  return new Map(entries);
}

export async function fetchTomTomIncidents(seed, apiKey, { fetchImpl = fetch } = {}) {
  if (!apiKey) return [];
  const lats = seed.stops.map((stop) => stop.lat);
  const lngs = seed.stops.map((stop) => stop.lng);
  const bbox = `${Math.min(...lngs)},${Math.min(...lats)},${Math.max(...lngs)},${Math.max(...lats)}`;
  const fields = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,startTime,endTime,from,to,description}}}';
  const url = new URL('https://api.tomtom.com/traffic/services/5/incidentDetails');
  url.search = new URLSearchParams({
    bbox, fields, language: 'en-US', timeValidityFilter: 'present', key: apiKey
  }).toString();
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`TomTom Incidents API returned HTTP ${response.status}`);
  const body = await response.json();
  return (body.incidents || []).map((feature) => ({
    id: feature.properties?.id,
    category: feature.properties?.iconCategory ?? null,
    delay_magnitude: feature.properties?.magnitudeOfDelay ?? null,
    from: feature.properties?.from ?? null,
    to: feature.properties?.to ?? null,
    description: feature.properties?.description ?? null,
    coordinates: feature.geometry?.coordinates ?? null
  }));
}

export async function fetchRainMultiplier(seed, { fetchImpl = fetch, at = new Date() } = {}) {
  const parts = phtParts(at);
  const lat = seed.stops.reduce((sum, stop) => sum + stop.lat, 0) / seed.stops.length;
  const lng = seed.stops.reduce((sum, stop) => sum + stop.lng, 0) / seed.stops.length;
  const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)}|${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
  if (weatherCache?.key === cacheKey && Date.now() - weatherCache.fetchedAt < WEATHER_CACHE_MS) {
    return weatherCache.value;
  }
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    hourly: 'precipitation,precipitation_probability',
    timezone: 'Asia/Manila',
    forecast_days: '2'
  }).toString();
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}`);
  const body = await response.json();
  const currentHour = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
  const index = body.hourly?.time?.indexOf(currentHour) ?? -1;
  if (index < 0) throw new Error('Open-Meteo response has no forecast for the current PHT hour');
  const precipitation = Number(body.hourly.precipitation?.[index] || 0);
  const probability = Number(body.hourly.precipitation_probability?.[index] || 0);
  const raining = precipitation > 0.1 || probability >= 50;
  const value = {
    multiplier: raining ? precipitation >= 2 ? 1.25 : 1.15 : 1,
    raining,
    precipitation_mm: precipitation,
    precipitation_probability: probability,
    source: 'open_meteo'
  };
  weatherCache = { key: cacheKey, fetchedAt: Date.now(), value };
  return value;
}

export async function runPollingCycle({
  seed,
  store,
  apiKey = process.env.BYAHE30_TOMTOM_API_KEY,
  fetchImpl = fetch,
  at = new Date(),
  force = false,
  weatherMultiplier
}) {
  const policy = getPollingPolicy(at);
  const due = force || isPollingMinute(at);
  if (!force && !due) {
    return { skipped: true, reason: policy.liveCallsAllowed ? 'not_scheduled_minute' : 'late_night', policy, records: [] };
  }
  if (!policy.liveCallsAllowed) {
    return { skipped: true, reason: 'late_night', policy, records: [] };
  }

  const [history, weatherResult] = await Promise.all([
    store.list(),
    weatherMultiplier === undefined
      ? fetchRainMultiplier(seed, { fetchImpl, at }).catch((error) => ({ multiplier: 1, raining: false, error: error.message, source: 'historical_baseline' }))
      : Promise.resolve({ multiplier: weatherMultiplier, raining: weatherMultiplier > 1, source: 'configured' })
  ]);
  let liveDurations = null;
  let liveError = null;
  let incidents = [];
  let incidentError = null;

  if (apiKey) {
    try {
      [liveDurations, incidents] = await Promise.all([
        fetchTomTomDurations(seed, apiKey, { fetchImpl }),
        fetchTomTomIncidents(seed, apiKey, { fetchImpl }).catch((error) => {
          incidentError = error.message;
          return [];
        })
      ]);
    } catch (error) {
      liveError = error.message;
    }
  } else {
    liveError = 'TomTom Traffic API key is not configured';
  }
  const multiplier = Number.isFinite(weatherResult.multiplier) && weatherResult.multiplier >= 1 && weatherResult.multiplier <= 1.25
    ? weatherResult.multiplier
    : 1;
  const fallbackHistory = multiplier > 1
    ? history.filter((record) => !record.weather?.raining)
    : history;
  const records = seed.segments.map((segment) => {
    const raw = liveDurations?.get(segment.segment_id);
    if (raw) {
      const adjusted = Math.max(1, Math.round(raw * multiplier));
      return {
        segment_id: segment.segment_id,
        recorded_at: formatPhtIso(at),
        live_duration_sec: adjusted,
        congestion_ratio: adjusted / segment.baseline_duration_sec,
        source: 'live_routing',
        incidents,
        weather: weatherResult
      };
    }
    const fallback = resolveSegmentTelemetry(segment, fallbackHistory, at);
    const adjusted = Math.max(1, Math.round(fallback.live_duration_sec * multiplier));
    return {
      ...fallback,
      recorded_at: formatPhtIso(at),
      live_duration_sec: adjusted,
      congestion_ratio: adjusted / segment.baseline_duration_sec,
      incidents,
      weather: weatherResult
    };
  });
  await store.append(records);
  return {
    skipped: false,
    policy,
    source: liveDurations ? 'live_routing' : 'historical_baseline',
    live_error: liveError,
    incident_error: incidentError,
    weather: weatherResult,
    records
  };
}
