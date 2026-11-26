import { formatPht, parsePhtDateTime, phtParts } from '../time.mjs';
import { getApplicableSchedules } from './headway.mjs';
import { getPath, getPrimaryRoute, getSegmentMetric } from './path.mjs';

function interpolate(start, end, ratio) {
  return [start.lng + (end.lng - start.lng) * ratio, start.lat + (end.lat - start.lat) * ratio];
}

function roadPosition(coordinates, ratio, fallbackStart, fallbackEnd) {
  if (!coordinates || coordinates.length < 2) return interpolate(fallbackStart, fallbackEnd, ratio);
  const radians = (degrees) => degrees * Math.PI / 180;
  const lengths = coordinates.slice(0, -1).map((point, index) => {
    const next = coordinates[index + 1];
    const lat1 = radians(point[1]), lat2 = radians(next[1]);
    const dLat = lat2 - lat1, dLng = radians(next[0] - point[0]);
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
  });
  const target = lengths.reduce((sum, length) => sum + length, 0) * ratio;
  let distance = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (target <= distance + length || index === lengths.length - 1) {
      const fraction = length ? Math.max(0, Math.min(1, (target - distance) / length)) : 0;
      return [
        coordinates[index][0] + (coordinates[index + 1][0] - coordinates[index][0]) * fraction,
        coordinates[index][1] + (coordinates[index + 1][1] - coordinates[index][1]) * fraction
      ];
    }
    distance += length;
  }
  return coordinates.at(-1);
}

function serviceWindowStart(now) {
  const part = phtParts(now);
  return parsePhtDateTime(`${part.year}-${part.month}-${part.day}T05:30`);
}

export function generateEstimatedWaves({ seed, metrics = new Map(), at = new Date(), vehicleType = 'van', roadGeometries = null }) {
  const now = at instanceof Date ? at : parsePhtDateTime(at);
  const schedules = getApplicableSchedules(seed, now);
  const schedule = schedules.find((item) => item.vehicle_type === vehicleType) ?? schedules.find((item) => item.vehicle_type === 'any');
  if (!schedule) return { corridor_id: seed.corridor.id, as_of: now.toISOString(), source: 'historical_baseline', vehicle_type: vehicleType, waves: [] };
  const scheduledVehicleType = schedule.vehicle_type === 'any' ? 'any' : vehicleType;
  const stops = [...seed.stops].sort((a, b) => a.sequence_order - b.sequence_order);
  const segments = seed.segments;
  const durations = segments.map((segment) => getSegmentMetric(segment, metrics).live_duration_sec);
  const measuredTripSec = durations.reduce((sum, duration) => sum + duration, 0);
  const historicalTripCapSec = Math.round(segments.reduce((sum, segment) => sum + segment.baseline_duration_sec, 0) * 1.8);
  const waveLifetimeSec = Math.min(measuredTripSec, historicalTripCapSec);
  const start = serviceWindowStart(now);
  const startPart = phtParts(now);
  const startDate = `${startPart.year}-${startPart.month}-${startPart.day}`;
  const startTime = new Date(`${startDate}T${schedule.start_time}:00+08:00`);
  const endTime = new Date(`${startDate}T${schedule.end_time}:00+08:00`);
  const firstDeparture = startTime > start ? startTime : start;
  const headwayMs = schedule.headway_minutes * 60_000;
  const waves = [];

  for (let departure = firstDeparture.getTime(); departure <= now.getTime() && departure <= endTime.getTime(); departure += headwayMs) {
    const elapsed = Math.floor((now.getTime() - departure) / 1000);
    if (elapsed >= waveLifetimeSec) continue;
    let remaining = elapsed;
    let segmentIndex = 0;
    while (segmentIndex < durations.length - 1 && remaining >= durations[segmentIndex]) {
      remaining -= durations[segmentIndex];
      segmentIndex += 1;
    }
    const segment = segments[segmentIndex];
    const from = stops.find((stop) => stop.stop_id === segment.from_stop_id);
    const to = stops.find((stop) => stop.stop_id === segment.to_stop_id);
    const ratio = Math.max(0, Math.min(1, remaining / durations[segmentIndex]));
    const departAt = new Date(departure);
    const coordinates = roadGeometries?.get(segment.segment_id)?.coordinates;
    waves.push({
      trip_id: `estimated-${seed.corridor.id}-${departAt.toISOString()}`,
      route_id: getPrimaryRoute(seed).route_id,
      vehicle_type: scheduledVehicleType,
      label: `Estimated Wave (±8 mins)`,
      confidence_window_minutes: 8,
      departure_time: departAt.toISOString(),
      departure_time_pht: formatPht(departAt),
      progress_ratio: Number((elapsed / measuredTripSec).toFixed(4)),
      current_segment_id: segment.segment_id,
      position: roadPosition(coordinates, ratio, from, to),
      position_precision: coordinates?.length >= 2 ? 'osm_road_geometry_estimate' : 'checkpoint_interpolation_estimate'
    });
  }
  return {
    corridor_id: seed.corridor.id,
    as_of: now.toISOString(),
    as_of_pht: formatPht(now),
    source: [...metrics.values()].some((item) => item.source === 'live_routing') ? 'live_routing' : 'historical_baseline',
    vehicle_type: scheduledVehicleType,
    headway_minutes: schedule.headway_minutes,
    drift_clamped: measuredTripSec > historicalTripCapSec,
    waves
  };
}
