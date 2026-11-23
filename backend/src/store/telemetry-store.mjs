import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { TELEMETRY_PATH } from '../config.mjs';
import { phtParts } from '../time.mjs';

export class TelemetryStore {
  constructor(filename = TELEMETRY_PATH) {
    this.filename = filename;
  }

  async list() {
    let contents;
    try {
      contents = await readFile(this.filename, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return contents.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }

  async append(records) {
    if (!records.length) return;
    await mkdir(path.dirname(this.filename), { recursive: true });
    const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    await appendFile(this.filename, body, 'utf8');
  }
}

export class PostgresTelemetryStore {
  constructor(pool) {
    this.pool = pool;
  }

  async list() {
    const result = await this.pool.query(`
      select segment_id, recorded_at, live_duration_sec, congestion_ratio, source
      from telemetry_logs
      where recorded_at >= now() - interval '7 days'
      order by recorded_at desc
    `);
    return result.rows.map((row) => ({
      ...row,
      recorded_at: new Date(row.recorded_at).toISOString(),
      live_duration_sec: Number(row.live_duration_sec),
      congestion_ratio: Number(row.congestion_ratio)
    }));
  }

  async append(records) {
    if (!records.length) return;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const record of records) {
        await client.query(`
          insert into telemetry_logs (segment_id, recorded_at, live_duration_sec, congestion_ratio, source)
          values ($1, $2, $3, $4, $5)
        `, [record.segment_id, record.recorded_at, record.live_duration_sec, record.congestion_ratio, record.source]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function createTelemetryStore() {
  if (!process.env.DATABASE_URL) return new TelemetryStore();
  let pg;
  try {
    pg = await import('pg');
  } catch {
    throw new Error('DATABASE_URL is set but the optional pg package is not installed. Run npm install in backend/.');
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return new PostgresTelemetryStore(pool);
}

export function historicalAverage(records, segmentId, at = new Date(), days = 7) {
  const cutoff = at.getTime() - days * 24 * 60 * 60 * 1000;
  const targetHour = Number(phtParts(at).hour);
  const durations = records.filter((record) => {
    const time = new Date(record.recorded_at);
    return record.segment_id === segmentId && time >= cutoff && time <= at &&
      Number(phtParts(time).hour) === targetHour && Number(record.live_duration_sec) > 0;
  }).map((record) => Number(record.live_duration_sec));
  if (!durations.length) return null;
  return Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
}

export function resolveSegmentTelemetry(segment, records, at = new Date()) {
  const duration = historicalAverage(records, segment.segment_id, at) ?? segment.baseline_duration_sec;
  return {
    segment_id: segment.segment_id,
    live_duration_sec: duration,
    congestion_ratio: duration / segment.baseline_duration_sec,
    source: 'historical_baseline',
    recorded_at: at.toISOString()
  };
}
