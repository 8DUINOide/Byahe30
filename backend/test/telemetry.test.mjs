import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { historicalAverage, resolveSegmentTelemetry } from '../src/store/telemetry-store.mjs';
import { fetchRainMultiplier, fetchTomTomDurations, runPollingCycle } from '../src/workers/telemetry.mjs';

const seed = JSON.parse(await readFile(new URL('../../data/gtfs/baao-naga/seed.json', import.meta.url), 'utf8'));

function memoryStore(initial = []) {
  return {
    records: [...initial],
    async list() { return [...this.records]; },
    async append(records) { this.records.push(...records); }
  };
}

function openMeteoResponse(hour, precipitation = 0, probability = 0) {
  return {
    hourly: {
      time: [`${hour}:00`],
      precipitation: [precipitation],
      precipitation_probability: [probability]
    }
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

test('TomTom flow data resolves durations for each configured segment', async () => {
  const requests = [];
  const result = await fetchTomTomDurations(seed, 'mock-key', {
    fetchImpl: async (url) => {
      requests.push(new URL(url));
      return { ok: true, json: async () => ({ flowSegmentData: { currentSpeed: 60, freeFlowSpeed: 60 } }) };
    }
  });
  assert.equal(requests.length, seed.segments.length);
  assert.ok(requests.every((url) => url.hostname === 'api.tomtom.com'));
  assert.equal(result.get(seed.segments[0].segment_id), seed.segments[0].baseline_duration_sec);
});

test('TomTom closures produce a severe bounded slowdown instead of invalid zero-time data', async () => {
  const result = await fetchTomTomDurations(seed, 'mock-key', {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ flowSegmentData: { currentSpeed: 0, freeFlowSpeed: 60, roadClosure: true } })
    })
  });
  assert.equal(result.get(seed.segments[0].segment_id), seed.segments[0].baseline_duration_sec * 3);
});

test('rain alerts adjust live durations and incident telemetry is retained', async () => {
  const store = memoryStore();
  const at = new Date('2026-11-25T05:35:00+08:00');
  const hour = '2026-11-25T05';
  const requests = [];
  const result = await runPollingCycle({
    seed, store, apiKey: 'mock-key', at,
    fetchImpl: async (input) => {
      const url = new URL(input);
      requests.push(url);
      if (url.hostname === 'api.open-meteo.com') {
        return { ok: true, json: async () => openMeteoResponse(hour, 2.4, 90) };
      }
      if (url.pathname.endsWith('/incidentDetails')) {
        return { ok: true, json: async () => ({ incidents: [{
          geometry: { type: 'Point', coordinates: [123.3, 13.5] },
          properties: { id: 'incident-1', iconCategory: 8, description: 'Road works', from: 'Pili', to: 'Naga' }
        }] }) };
      }
      return { ok: true, json: async () => ({ flowSegmentData: { currentSpeed: 60, freeFlowSpeed: 60 } }) };
    }
  });
  assert.equal(result.source, 'live_routing');
  assert.equal(result.weather.multiplier, 1.25);
  assert.equal(result.records[0].live_duration_sec, Math.round(seed.segments[0].baseline_duration_sec * 1.25));
  assert.equal(result.records[0].incidents[0].id, 'incident-1');
  assert.ok(result.records[0].recorded_at.endsWith('+08:00'));
  assert.ok(requests.some((url) => url.pathname.endsWith('/incidentDetails')));
  assert.ok(store.records.every((record) => record.weather.multiplier === 1.25));
});

test('provider failures keep historical fallback rows', async () => {
  const segment = seed.segments[0];
  const history = [{
    segment_id: segment.segment_id,
    recorded_at: '2026-11-25T06:20:00+08:00',
    live_duration_sec: 900
  }];
  const store = memoryStore(history);
  const at = new Date('2026-11-25T06:35:00+08:00');
  const result = await runPollingCycle({
    seed, store, apiKey: 'mock-key', at,
    fetchImpl: async () => { throw new Error('mock timeout'); }
  });
  assert.equal(result.source, 'historical_baseline');
  assert.equal(result.live_error, 'mock timeout');
  assert.equal(result.records.length, seed.segments.length);
  assert.equal(result.records[0].live_duration_sec, 900);
  assert.ok(result.records.every((record) => record.source === 'historical_baseline'));
});

test('Open-Meteo rain alerts stay within configured multiplier bounds', async () => {
  const at = new Date('2026-11-26T06:35:00+08:00');
  const result = await fetchRainMultiplier(seed, {
    at,
    fetchImpl: async () => ({ ok: true, json: async () => openMeteoResponse('2026-11-26T06', 0.3, 70) })
  });
  assert.equal(result.raining, true);
  assert.equal(result.multiplier, 1.15);
});

test('rain multiplier is applied to baseline durations when live traffic is unavailable', async () => {
  const store = memoryStore();
  const at = new Date('2026-11-27T07:35:00+08:00');
  const result = await runPollingCycle({
    seed, store, at,
    fetchImpl: async () => ({
      ok: true,
      json: async () => openMeteoResponse('2026-11-27T07', 0, 65)
    })
  });
  assert.equal(result.source, 'historical_baseline');
  assert.equal(result.records[0].live_duration_sec, Math.round(seed.segments[0].baseline_duration_sec * 1.15));
  assert.equal(result.records[0].source, 'historical_baseline');
});

test('late night makes no traffic or weather requests', async () => {
  const store = memoryStore();
  let calls = 0;
  const result = await runPollingCycle({
    seed, store, apiKey: 'mock-key', at: new Date('2026-11-24T22:00:00+08:00'),
    fetchImpl: async () => { calls += 1; throw new Error('must not be called'); }
  });
  assert.equal(calls, 0);
  assert.equal(result.reason, 'late_night');
  assert.equal(store.records.length, 0);
});
