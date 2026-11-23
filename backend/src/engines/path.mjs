export function getPath(seed, originStopId, destinationStopId) {
  const stops = [...seed.stops].sort((a, b) => a.sequence_order - b.sequence_order);
  const start = stops.findIndex((stop) => stop.stop_id === originStopId);
  const end = stops.findIndex((stop) => stop.stop_id === destinationStopId);
  if (start < 0 || end < 0) throw new TypeError('origin_stop_id and destination_stop_id must belong to the selected corridor');
  if (start >= end) throw new TypeError('This corridor is modeled in one direction; choose an origin before the destination');
  const pathStops = stops.slice(start, end + 1);
  const segments = pathStops.slice(0, -1).map((stop, index) => {
    const nextStop = pathStops[index + 1];
    const segment = seed.segments.find((item) => item.from_stop_id === stop.stop_id && item.to_stop_id === nextStop.stop_id);
    if (!segment) throw new Error(`Missing segment between ${stop.stop_id} and ${nextStop.stop_id}`);
    return segment;
  });
  return { stops: pathStops, segments };
}

export function getPrimaryRoute(seed) {
  return seed.routes.find((route) => route.stop_ids.length === seed.stops.length) ?? seed.routes[0];
}

export function getSegmentMetric(segment, metricById = new Map()) {
  return metricById.get(segment.segment_id) ?? {
    segment_id: segment.segment_id,
    live_duration_sec: segment.baseline_duration_sec,
    congestion_ratio: 1,
    source: 'historical_baseline',
    recorded_at: null
  };
}
