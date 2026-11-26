import { formatPht, parsePhtDateTime } from '../time.mjs';
import { availableVehicleTypes, resolveHeadway } from './headway.mjs';
import { getPath, getSegmentMetric } from './path.mjs';

function travelSeconds(segments, metrics) {
  return segments.reduce((sum, segment) => sum + getSegmentMetric(segment, metrics).live_duration_sec, 0);
}

function bottlenecks(segments, metrics) {
  return segments.flatMap((segment) => {
    const metric = getSegmentMetric(segment, metrics);
    if (metric.congestion_ratio < 1.2) return [];
    return [{
      segment_id: segment.segment_id,
      delay_sec: Math.max(0, metric.live_duration_sec - segment.baseline_duration_sec),
      congestion_level: metric.congestion_ratio > 1.6 ? 'SEVERE' : 'MODERATE'
    }];
  });
}

export function compareRoutes({ seed, metrics = new Map(), originStopId, destinationStopId, at = new Date(), vehiclePreference = 'any' }) {
  const { stops, segments } = getPath(seed, originStopId, destinationStopId);
  const lastMileBufferSec = Number.isInteger(stops.at(-1).last_mile_buffer_sec) ? stops.at(-1).last_mile_buffer_sec : 0;
  const vehicleTypes = vehiclePreference === 'any'
    ? [...new Set([...availableVehicleTypes(seed, at), 'van'])]
    : [vehiclePreference];
  const direct = vehicleTypes.map((vehicleType) => {
    const headway = resolveHeadway(seed, at, vehicleType);
    const travel = travelSeconds(segments, metrics);
    const wait = headway.headway_minutes * 30;
    return { type: 'direct', vehicle_type: vehicleType, travel_time_sec: travel, wait_time_sec: wait, last_mile_buffer_sec: lastMileBufferSec, total_time_sec: travel + wait + lastMileBufferSec, bottlenecks: bottlenecks(segments, metrics), source: headway.source };
  }).sort((a, b) => a.total_time_sec - b.total_time_sec)[0];

  const cutTrips = [];
  for (let index = 1; index < stops.length - 1; index += 1) {
    if (!stops[index].is_transfer_hub) continue;
    const firstLeg = segments.slice(0, index);
    const secondLeg = segments.slice(index);
    const firstTime = travelSeconds(firstLeg, metrics);
    const secondTime = travelSeconds(secondLeg, metrics);
    for (const firstVehicle of vehicleTypes) {
      for (const secondVehicle of vehicleTypes) {
        const firstHeadway = resolveHeadway(seed, at, firstVehicle);
        const secondHeadway = resolveHeadway(seed, at, secondVehicle);
        const originWait = firstHeadway.headway_minutes * 30;
        const transferWait = secondHeadway.headway_minutes * 30;
        cutTrips.push({
          type: 'cut_trip',
          transfer_stop_id: stops[index].stop_id,
          transfer_stop: stops[index].stop_name,
          first_vehicle_type: firstVehicle,
          second_vehicle_type: secondVehicle,
          first_leg_time_sec: firstTime,
          second_leg_time_sec: secondTime,
          travel_time_sec: firstTime + secondTime,
          bottlenecks: bottlenecks([...firstLeg, ...secondLeg], metrics),
          wait_time_sec: originWait + transferWait,
          last_mile_buffer_sec: lastMileBufferSec,
          total_time_sec: firstTime + secondTime + originWait + transferWait + lastMileBufferSec,
          source: firstHeadway.source === 'scheduled' && secondHeadway.source === 'scheduled' ? 'scheduled' : 'historical_baseline'
        });
      }
    }
  }
  cutTrips.sort((a, b) => a.total_time_sec - b.total_time_sec);
  const bestCut = cutTrips[0] ?? null;
  const recommendation = bestCut && bestCut.total_time_sec < direct.total_time_sec ? bestCut : direct;
  const target = at instanceof Date ? at : parsePhtDateTime(at);
  return {
    evaluated_at: target.toISOString(),
    evaluated_at_pht: formatPht(target),
    direct,
    best_cut_trip: bestCut,
    recommendation: recommendation.type,
    recommendation_summary: recommendation.type === 'direct'
      ? 'Direct service has the shorter estimated total time.'
      : `Cut trip via ${bestCut.transfer_stop} has the shorter estimated total time.`,
    alternatives: cutTrips
  };
}
