import { getPrimaryRoute, getSegmentMetric } from './path.mjs';

const METERS_PER_DEGREE_LAT = 110_540;
const MAX_ROUTE_DISTANCE_M = 2_500;

export function projectOntoCorridor(seed, latitude, longitude, route = getPrimaryRoute(seed)) {
  const stopById = new Map(seed.stops.map((stop) => [stop.stop_id, stop]));
  const stops = (route?.stop_ids || []).map((stopId) => stopById.get(stopId)).filter(Boolean);
  const segmentByPair = new Map(seed.segments.map((segment) => [`${segment.from_stop_id}:${segment.to_stop_id}`, segment]));
  let distanceBeforeKm = 0;
  let closest = null;

  for (let index = 0; index < stops.length - 1; index += 1) {
    const from = stops[index];
    const to = stops[index + 1];
    const segment = segmentByPair.get(`${from.stop_id}:${to.stop_id}`);
    if (!segment) continue;

    const latitudeScale = METERS_PER_DEGREE_LAT;
    const longitudeScale = METERS_PER_DEGREE_LAT * Math.cos(((latitude + from.lat + to.lat) / 3) * Math.PI / 180);
    const ax = (from.lng - longitude) * longitudeScale;
    const ay = (from.lat - latitude) * latitudeScale;
    const bx = (to.lng - longitude) * longitudeScale;
    const by = (to.lat - latitude) * latitudeScale;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared ? Math.max(0, Math.min(1, -((ax * dx) + (ay * dy)) / lengthSquared)) : 0;
    const offsetX = ax + fraction * dx;
    const offsetY = ay + fraction * dy;
    const distanceM = Math.hypot(offsetX, offsetY);
    if (!closest || distanceM < closest.distance_to_route_m) {
      closest = {
        distance_to_route_m: distanceM,
        progress_km: distanceBeforeKm + (Number(segment.distance_km) * fraction),
        segment_index: index
      };
    }
    distanceBeforeKm += Number(segment.distance_km);
  }

  if (!closest || closest.distance_to_route_m > MAX_ROUTE_DISTANCE_M) return null;
  return { ...closest, corridor_distance_km: distanceBeforeKm };
}

export function getVehicleArrivals({ seed, route = getPrimaryRoute(seed), metrics = new Map(), progressKm, direction }) {
  const stopById = new Map(seed.stops.map((stop) => [stop.stop_id, stop]));
  const stops = (route?.stop_ids || []).map((stopId) => stopById.get(stopId)).filter(Boolean);
  const segments = stops.slice(0, -1).map((stop, index) => {
    const next = stops[index + 1];
    return seed.segments.find((item) => item.from_stop_id === stop.stop_id && item.to_stop_id === next.stop_id);
  });
  if (segments.some((segment) => !segment)) return [];

  const stopProgress = [0];
  for (const segment of segments) stopProgress.push(stopProgress.at(-1) + Number(segment.distance_km));
  const totalDistanceKm = stopProgress.at(-1) || 0;
  const reverse = direction === 'reverse';
  const clampedProgress = Math.max(0, Math.min(totalDistanceKm, Number(progressKm)));

  const travelSecondsBetween = (startKm, endKm) => {
    const low = Math.min(startKm, endKm);
    const high = Math.max(startKm, endKm);
    return segments.reduce((total, segment, index) => {
      const segmentStart = stopProgress[index];
      const segmentEnd = stopProgress[index + 1];
      const overlapKm = Math.max(0, Math.min(high, segmentEnd) - Math.max(low, segmentStart));
      if (!overlapKm) return total;
      const duration = getSegmentMetric(segment, metrics).live_duration_sec;
      return total + duration * (overlapKm / Math.max(segmentEnd - segmentStart, 0.001));
    }, 0);
  };

  const candidates = stops.map((stop, index) => ({ stop, progress: stopProgress[index] }))
    .filter(({ progress }) => reverse ? progress < clampedProgress - 0.05 : progress > clampedProgress + 0.05)
    .sort((a, b) => reverse ? b.progress - a.progress : a.progress - b.progress);

  return candidates.map(({ stop, progress }) => {
    const etaSeconds = Math.max(0, Math.round(travelSecondsBetween(clampedProgress, progress)));
    const etaMinutes = Math.ceil(etaSeconds / 60);
    return {
      stop_id: stop.stop_id,
      stop_name: stop.stop_name,
      eta_seconds: etaSeconds,
      eta_minutes: etaMinutes,
      confidence_window_minutes: Math.max(2, Math.ceil(etaMinutes * 0.2))
    };
  });
}
