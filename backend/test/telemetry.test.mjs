import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { historicalAverage, resolveSegmentTelemetry } from '../src/store/telemetry-store.mjs';
import { fetchMatrixDurations, runPollingCycle } from '../src/workers/telemetry.mjs';

const seed = JSON.parse(await readFile(new URL('../../data/gtfs/baao-naga/seed.json', import.meta.url), 'utf8'));

function memoryStore(initial = []) {
  return {
    records: [...initial],
    async list() { return [...this.records]; },
    async append(records) { this.records.push(...records); }
  };
}

test('same-hour history is averaged, then seed duration is used when history is empty', () => {
  const segment = seed.segments[0];
  const at = new Date('2026-11-24T01:30:00+08:00');
  const history = [
    { segment_id: segment.segment_id, recorded_at: '2026-11-23T01:00:00+08:00', live_duration_sec: 600 },
    { segment_id: segment.segment_id, recorded_at: '2026-11-22T01:45:00+08:00', live_duration_sec: 900 }
  ];
  assert.equal(historicalAverage(history, segment.segment_id, at), 750);
  assert.equal(resolveSegmentTelemetry(segment, [], at).live_duration_sec, segment.baseline_duration_sec);
});

test('routing matrix durations map in corridor order with adjacent checkpoint pairs', async () => {
  const requests = [];
  const result = await fetchMatrixDurations(seed, 'mock-token', {
    fetchImpl: async (url) => {
      requests.push(new URL(url));
      const size = seed.segments.length;
      const durations = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => row === col ? 100 + row : 0));
      return { ok: true, json: async () => ({ code: 'Ok', durations }) };
    }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('sources'), '0;1;2;3;4;5;6');
  assert.equal(requests[0].searchParams.get('destinations'), '1;2;3;4;5;6;7');
  assert.equal(result.get(seed.segments[0].segment_id), 100);
  assert.equal(result.get(seed.segments.at(-1).segment_id), 106);
});

test('API timeout records historical fallback without losing segment rows', async () => {
  const store = memoryStore();
  let calls = 0;
  const at = new Date('2026-11-24T05:35:00+08:00');
  const result = await runPollingCycle({
    seed, store, token: 'test-token', at,
    fetchImpl: async () => { calls += 1; throw new Error('mock timeout'); }
  });
  assert.equal(calls, 1);
  assert.equal(result.source, 'historical_baseline');
  assert.equal(result.live_error, 'mock timeout');
  assert.equal(result.records.length, seed.segments.length);
  assert.ok(result.records.every((record) => record.source === 'historical_baseline'));
  assert.equal(store.records.length, seed.segments.length);
});

test('late night never calls the live routing provider', async () => {
  const store = memoryStore();
  let calls = 0;
  const result = await runPollingCycle({
    seed, store, token: 'test-token', at: new Date('2026-11-24T22:00:00+08:00'),
    fetchImpl: async () => { calls += 1; throw new Error('must not be called'); }
  });
  assert.equal(calls, 0);
  assert.equal(result.reason, 'late_night');
  assert.equal(store.records.length, 0);
});
