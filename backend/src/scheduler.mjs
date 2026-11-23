import { phtMinuteOfDay } from './time.mjs';

const PEAK_WINDOWS = [[5 * 60 + 30, 8 * 60 + 30], [16 * 60 + 30, 19 * 60 + 30]];
const OFF_PEAK_WINDOWS = [[8 * 60 + 31, 16 * 60 + 29], [19 * 60 + 31, 21 * 60 + 30]];

export function getPollingPolicy(at = new Date()) {
  const minute = phtMinuteOfDay(at);
  if (PEAK_WINDOWS.some(([start, end]) => minute >= start && minute <= end)) {
    return { window: 'peak', intervalMinutes: 5, liveCallsAllowed: true };
  }
  if (OFF_PEAK_WINDOWS.some(([start, end]) => minute >= start && minute <= end)) {
    return { window: 'off_peak', intervalMinutes: 15, liveCallsAllowed: true };
  }
  return { window: 'late_night', intervalMinutes: 0, liveCallsAllowed: false };
}

// Designed for a cron trigger that runs every minute. Modulo alignment avoids
// an accidental five-minute cadence during off-peak periods.
export function isPollingMinute(at = new Date()) {
  const policy = getPollingPolicy(at);
  return policy.liveCallsAllowed && phtMinuteOfDay(at) % policy.intervalMinutes === 0;
}
