import test from 'node:test';
import assert from 'node:assert/strict';
import { getPollingPolicy, isPollingMinute } from '../src/scheduler.mjs';

const pht = (time) => new Date(`2026-11-24T${time}:00+08:00`);

test('polling policy respects all PHT window boundaries', () => {
  assert.equal(getPollingPolicy(pht('05:29')).window, 'late_night');
  assert.deepEqual(getPollingPolicy(pht('05:30')), { window: 'peak', intervalMinutes: 5, liveCallsAllowed: true });
  assert.equal(getPollingPolicy(pht('08:30')).window, 'peak');
  assert.equal(getPollingPolicy(pht('08:31')).intervalMinutes, 15);
  assert.equal(getPollingPolicy(pht('16:29')).window, 'off_peak');
  assert.equal(getPollingPolicy(pht('16:30')).window, 'peak');
  assert.equal(getPollingPolicy(pht('19:30')).window, 'peak');
  assert.equal(getPollingPolicy(pht('19:31')).window, 'off_peak');
  assert.equal(getPollingPolicy(pht('21:30')).window, 'off_peak');
  assert.deepEqual(getPollingPolicy(pht('21:31')), { window: 'late_night', intervalMinutes: 0, liveCallsAllowed: false });
});

test('scheduled poll minute aligns with the active interval', () => {
  assert.equal(isPollingMinute(pht('05:35')), true);
  assert.equal(isPollingMinute(pht('05:36')), false);
  assert.equal(isPollingMinute(pht('09:00')), true);
  assert.equal(isPollingMinute(pht('09:05')), false);
  assert.equal(isPollingMinute(pht('21:45')), false);
});
