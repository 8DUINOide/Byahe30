import { formatPht, parsePhtDateTime, phtParts } from '../time.mjs';
import { getApplicableSchedules } from './headway.mjs';
import { getPath, getPrimaryRoute, getSegmentMetric } from './path.mjs';

function interpolate(start, end, ratio) {
  return [start.lng + (end.lng - start.lng) * ratio, start.lat + (end.lat - start.lat) * ratio];
}

function serviceWindowStart(now) {
  const part = phtParts(now);
  return parsePhtDateTime(`${part.year}-${part.month}-${part.day}T05:30`);
}

export function generateEstimatedWaves({ seed, metrics = new Map(), at = new Date(), vehicleType = 'van' }) {
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
    waves.push({
      trip_id: `estimated-${seed.corridor.id}-${departAt.toISOString()}`,
      route_id: getPrimaryRoute(seed).route_id,
      vehicle_type: scheduledVehicleType,
      label: 'Estimated Wave',
      confidence_window_minutes: 8,
      departure_time: departAt.toISOString(),
      departure_time_pht: formatPht(departAt),
      progress_ratio: Number((elapsed / measuredTripSec).toFixed(4)),
      current_segment_id: segment.segment_id,
      position: interpolate(from, to, ratio),
      position_precision: 'checkpoint_interpolation_estimate'
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
