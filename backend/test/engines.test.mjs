import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculateReverseDeparture } from '../src/engines/reverse-departure.mjs';
import { compareRoutes } from '../src/engines/route-comparator.mjs';
import { generateEstimatedWaves } from '../src/engines/virtual-wave.mjs';

const seed = JSON.parse(await readFile(new URL('../../data/gtfs/baao-naga/seed.json', import.meta.url), 'utf8'));
const target = '2026-11-24T07:30';

test('reverse departure sums travel, half-headway wait, and ADNU last mile', () => {
  const result = calculateReverseDeparture({
    seed, originStopId: 'baao_centro', destinationStopId: 'adnu_main',
    targetArrivalTime: target, vehiclePreference: 'van'
  });
  assert.equal(result.breakdown.travel_time_sec, 3420);
  assert.equal(result.breakdown.headway_wait_sec, 300);
  assert.equal(result.breakdown.last_mile_buffer_sec, 480);
  assert.equal(result.breakdown.terminal_wait_buffer_sec, 300);
  assert.equal(result.leave_home_by, '2026-11-23T22:20:00.000Z');
  assert.equal(result.leave_home_by_pht, 'Nov 24, 2026, 6:20 AM');
});

test('Palestina congestion advances the departure estimate and raises a warning', () => {
  const segment = seed.segments.find((item) => item.segment_id === 'palestina_del_rosario');
  const metrics = new Map([[segment.segment_id, {
    segment_id: segment.segment_id, live_duration_sec: 900,
    congestion_ratio: 3, source: 'live_routing'
  }]]);
  const result = calculateReverseDeparture({
    seed, metrics, originStopId: 'baao_centro', destinationStopId: 'adnu_main',
    targetArrivalTime: target, vehiclePreference: 'van'
  });
  assert.equal(result.breakdown.travel_time_sec, 4020);
  assert.equal(result.confidence_window_minutes, 5);
  assert.ok(result.warnings.some((warning) => warning.includes('Severe')));
  assert.equal(result.segments.find((item) => item.segment_id === segment.segment_id).congestion_level, 'SEVERE');
});

test('direct and transfer options include transfer wait and return a recommendation', () => {
  const result = compareRoutes({
    seed, originStopId: 'baao_centro', destinationStopId: 'adnu_main',
    at: new Date('2026-11-23T23:30:00.000Z'), vehiclePreference: 'any'
  });
  assert.equal(result.direct.total_time_sec, 4200);
  assert.ok(result.alternatives.some((item) => item.transfer_stop_id === 'pili_centro'));
  assert.ok(result.best_cut_trip.wait_time_sec >= result.direct.wait_time_sec);
  assert.equal(result.recommendation, 'direct');
});

test('virtual runs are labeled as estimates and interpolated on corridor checkpoints', () => {
  const result = generateEstimatedWaves({ seed, at: new Date('2026-11-24T00:30:00.000Z'), vehicleType: 'van' });
  assert.ok(result.waves.length > 0);
  assert.equal(result.waves[0].label, 'Estimated Wave (±8 mins)');
  assert.equal(result.waves[0].position_precision, 'checkpoint_interpolation_estimate');
  assert.ok(result.waves.every((wave) => wave.confidence_window_minutes > 0));
});

test('all stops carry direction, landmark, and transfer metadata', () => {
  assert.ok(seed.stops.every((stop) =>
    ['northbound', 'southbound'].includes(stop.direction) &&
    stop.served_directions.includes('northbound') &&
    stop.served_directions.includes('southbound') &&
    Array.isArray(stop.landmarks) && stop.landmarks.length > 0
  ));
  assert.equal(seed.stops.find((stop) => stop.stop_id === 'pili_centro').is_transfer_hub, true);
  assert.equal(seed.stops.find((stop) => stop.stop_id === 'naga_terminal').is_transfer_hub, true);
});

test('estimated wave positions use OSM segment geometry when available', () => {
  const segment = seed.segments[0];
  const roadGeometries = new Map([[segment.segment_id, {
    type: 'LineString',
    coordinates: [[123.3653, 13.4533], [123.34, 13.49], [123.2941, 13.5247]]
  }]]);
  const result = generateEstimatedWaves({
    seed, roadGeometries, at: new Date('2026-11-24T00:30:00.000Z'), vehicleType: 'van'
  });
  assert.ok(result.waves.some((wave) => wave.position_precision === 'osm_road_geometry_estimate'));
});

test('virtual waves expire at the historical drift cap', () => {
  const metrics = new Map(seed.segments.map((segment) => [segment.segment_id, {
    segment_id: segment.segment_id,
    live_duration_sec: segment.baseline_duration_sec * 3,
    congestion_ratio: 3,
    source: 'live_routing'
  }]));
  const now = new Date('2026-11-24T07:20:00+08:00');
  const result = generateEstimatedWaves({ seed, metrics, at: now, vehicleType: 'van' });
  assert.equal(result.drift_clamped, true);
  const capSec = seed.segments.reduce((sum, segment) => sum + segment.baseline_duration_sec, 0) * 1.8;
  assert.ok(result.waves.length > 0);
  assert.ok(result.waves.every((wave) => (now.getTime() - new Date(wave.departure_time).getTime()) / 1000 < capSec));
});
