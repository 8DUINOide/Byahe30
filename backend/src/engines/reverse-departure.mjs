import { formatPht, parsePhtDateTime } from '../time.mjs';
import { getPath, getSegmentMetric } from './path.mjs';
import { resolveHeadway } from './headway.mjs';

export function calculateReverseDeparture({ seed, metrics = new Map(), originStopId, destinationStopId, targetArrivalTime, vehiclePreference = 'any' }) {
  const target = parsePhtDateTime(targetArrivalTime);
  const { stops, segments } = getPath(seed, originStopId, destinationStopId);
  const segmentBreakdown = segments.map((segment) => {
    const metric = getSegmentMetric(segment, metrics);
    const from = seed.stops.find((stop) => stop.stop_id === segment.from_stop_id);
    const to = seed.stops.find((stop) => stop.stop_id === segment.to_stop_id);
    return {
      segment_id: segment.segment_id,
      from_stop: from.stop_name,
      to_stop: to.stop_name,
      duration_sec: metric.live_duration_sec,
      congestion_ratio: metric.congestion_ratio,
      congestion_level: metric.congestion_ratio > 1.6 ? 'SEVERE' : metric.congestion_ratio >= 1.2 ? 'MODERATE' : 'CLEAR',
      source: metric.source
    };
  });
  const travelTimeSec = segmentBreakdown.reduce((sum, item) => sum + item.duration_sec, 0);
  const destinationStop = stops.at(-1);
  const lastMileBufferSec = Number.isInteger(destinationStop.last_mile_buffer_sec) ? destinationStop.last_mile_buffer_sec : 0;
  const noWaitDeparture = new Date(target.getTime() - (travelTimeSec + lastMileBufferSec) * 1000);
  let targetSchedule = resolveHeadway(seed, noWaitDeparture, vehiclePreference);
  let waitBufferSec = Math.round(targetSchedule.headway_minutes * 30);
  let leaveBy = new Date(target.getTime() - (travelTimeSec + waitBufferSec + lastMileBufferSec) * 1000);
  const departureSchedule = resolveHeadway(seed, leaveBy, vehiclePreference);
  if (departureSchedule.headway_minutes !== targetSchedule.headway_minutes || departureSchedule.source !== targetSchedule.source) {
    targetSchedule = departureSchedule;
    waitBufferSec = Math.round(targetSchedule.headway_minutes * 30);
    leaveBy = new Date(target.getTime() - (travelTimeSec + waitBufferSec + lastMileBufferSec) * 1000);
  }
  const sources = new Set(segmentBreakdown.map((item) => item.source));
  const warnings = [];
  if (segmentBreakdown.some((item) => item.congestion_level === 'SEVERE')) warnings.push('Severe corridor delay on one or more segments.');
  else if (segmentBreakdown.some((item) => item.congestion_level === 'MODERATE')) warnings.push('Moderate corridor delay on one or more segments.');
  if (targetSchedule.source === 'historical_baseline') warnings.push('No matching headway schedule; using a 15-minute planning estimate.');
  return {
    corridor_id: seed.corridor.id,
    origin_stop_id: originStopId,
    destination_stop_id: destinationStopId,
    target_arrival_time: target.toISOString(),
    target_arrival_time_pht: formatPht(target),
    leave_home_by: leaveBy.toISOString(),
    leave_home_by_pht: formatPht(leaveBy),
    vehicle_preference: vehiclePreference,
    breakdown: {
      travel_time_sec: travelTimeSec,
      headway_wait_sec: waitBufferSec,
      terminal_wait_buffer_sec: waitBufferSec,
      headway_minutes: targetSchedule.headway_minutes,
      last_mile_buffer_sec: lastMileBufferSec,
      total_planning_time_sec: travelTimeSec + waitBufferSec + lastMileBufferSec
    },
    data_source: sources.size === 1 ? [...sources][0] : 'mixed',
    confidence_window_minutes: sources.has('live_routing') ? 5 : 12,
    warnings,
    segments: segmentBreakdown
  };
}
