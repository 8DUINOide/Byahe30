import { getPollingPolicy, isPollingMinute } from '../scheduler.mjs';
import { resolveSegmentTelemetry } from '../store/telemetry-store.mjs';

export async function fetchMatrixDurations(seed, token, { fetchImpl = fetch, at = new Date() } = {}) {
  if (!token) throw new Error('Mapbox access token is not configured');
  const stops = [...seed.stops].sort((a, b) => a.sequence_order - b.sequence_order);
  const durations = new Map();
  const maxCoordinates = 10;
  for (let startIndex = 0; startIndex < seed.segments.length; startIndex += maxCoordinates - 1) {
    const chunkStops = stops.slice(startIndex, startIndex + maxCoordinates);
    const coordinates = chunkStops.map(({ lng, lat }) => `${lng},${lat}`).join(';');
    const sources = chunkStops.slice(0, -1).map((_, index) => index).join(';');
    const destinations = chunkStops.slice(1).map((_, index) => index + 1).join(';');
    const url = new URL(`https://api.mapbox.com/directions-matrix/v1/mapbox/driving-traffic/${coordinates}`);
    url.search = new URLSearchParams({ access_token: token, annotations: 'duration', sources, destinations }).toString();
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Routing provider returned HTTP ${response.status}`);
    const body = await response.json();
    if (body.code !== 'Ok' || !Array.isArray(body.durations)) throw new Error(body.message || 'Routing provider returned an invalid matrix');
    for (let localIndex = 0; localIndex < chunkStops.length - 1; localIndex += 1) {
      const segment = seed.segments[startIndex + localIndex];
      const seconds = body.durations[localIndex]?.[localIndex];
      if (Number.isFinite(seconds) && seconds > 0) durations.set(segment.segment_id, Math.round(seconds));
    }
  }
  if (durations.size !== seed.segments.length) throw new Error('Routing provider returned one or more unroutable corridor segments');
  return durations;
}

export async function runPollingCycle({ seed, store, token = process.env.MAPBOX_ACCESS_TOKEN, fetchImpl = fetch, at = new Date(), force = false, weatherMultiplier = 1 }) {
  const policy = getPollingPolicy(at);
  const due = force || isPollingMinute(at);
  let liveDurations = null;
  let liveError = null;

  if (!force && !due) {
    return { skipped: true, reason: policy.liveCallsAllowed ? 'not_scheduled_minute' : 'late_night', policy, records: [] };
  }

  // Forced runs never bypass the zero-call late-night rule.
  if (policy.liveCallsAllowed && token) {
    try {
      liveDurations = await fetchMatrixDurations(seed, token, { fetchImpl, at });
    } catch (error) {
      liveError = error.message;
    }
  } else if (policy.liveCallsAllowed) {
    liveError = 'Mapbox access token is not configured';
  }

  const history = await store.list();
  const multiplier = Number.isFinite(weatherMultiplier) && weatherMultiplier >= 1 && weatherMultiplier <= 2 ? weatherMultiplier : 1;
  const records = seed.segments.map((segment) => {
    const raw = liveDurations?.get(segment.segment_id);
    if (raw) {
      const adjusted = Math.max(1, Math.round(raw * multiplier));
      return {
        segment_id: segment.segment_id,
        recorded_at: at.toISOString(),
        live_duration_sec: adjusted,
        congestion_ratio: adjusted / segment.baseline_duration_sec,
        source: 'live_routing'
      };
    }
    return resolveSegmentTelemetry(segment, history, at);
  });
  await store.append(records);
  return {
    skipped: false,
    policy,
    source: liveDurations ? 'live_routing' : 'historical_baseline',
    live_error: liveError,
    records
  };
}
