import { weekdayType } from '../time.mjs';

export function getApplicableSchedules(seed, at = new Date()) {
  const day = weekdayType(at);
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(at);
  return seed.headway_schedules.filter((schedule) =>
    (schedule.day_type === day || schedule.day_type === 'daily') &&
    schedule.start_time <= hhmm && schedule.end_time >= hhmm
  );
}

export function resolveHeadway(seed, at, vehiclePreference = 'any') {
  const schedules = getApplicableSchedules(seed, at);
  const preferred = schedules.find((item) => item.vehicle_type === vehiclePreference);
  if (preferred) return { ...preferred, source: 'scheduled' };
  if (vehiclePreference === 'any') {
    const options = schedules.filter((item) => item.vehicle_type !== 'any');
    if (options.length) return { ...options.reduce((best, item) => item.headway_minutes < best.headway_minutes ? item : best), source: 'scheduled' };
  }
  const any = schedules.find((item) => item.vehicle_type === 'any');
  if (any) return { ...any, source: 'scheduled' };
  return { vehicle_type: vehiclePreference, headway_minutes: 15, source: 'historical_baseline' };
}

export function availableVehicleTypes(seed, at) {
  return [...new Set(getApplicableSchedules(seed, at).map((item) => item.vehicle_type))].filter((item) => item !== 'any');
}
