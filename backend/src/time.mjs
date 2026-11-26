export const TIME_ZONE = 'Asia/Manila';

export function phtParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short'
  }).formatToParts(value);
  return Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
}

export function phtMinuteOfDay(value = new Date()) {
  const { hour, minute } = phtParts(value);
  return Number(hour) * 60 + Number(minute);
}

export function formatPht(value) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: TIME_ZONE,
    dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h12'
  }).format(value);
}

export function formatPhtIso(value) {
  const { year, month, day, hour, minute, second } = phtParts(value);
  const milliseconds = String(value.getUTCMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${milliseconds}+08:00`;
}

export function parsePhtDateTime(input) {
  if (typeof input !== 'string') throw new TypeError('target_arrival_time must be a date-time string');
  const localPht = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input);
  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input);
  if (!localPht && !explicitZone) {
    throw new TypeError('target_arrival_time must be PHT local YYYY-MM-DDTHH:mm or include a timezone offset');
  }
  const parsed = new Date(localPht ? `${input}:00+08:00` : input);
  if (Number.isNaN(parsed.getTime())) throw new TypeError('target_arrival_time is invalid');
  return parsed;
}

export function weekdayType(value = new Date()) {
  const weekday = phtParts(value).weekday;
  return weekday === 'Sat' || weekday === 'Sun' ? 'weekend' : 'weekday';
}
