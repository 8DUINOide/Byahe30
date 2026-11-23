import { listSeeds, loadSeedById } from '../config.mjs';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the target PostgreSQL or Supabase database.');
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const seeds = process.env.BYAHE30_CORRIDOR_ID
  ? [await loadSeedById(process.env.BYAHE30_CORRIDOR_ID)]
  : (await listSeeds()).filter((seed) => seed.corridor.is_active);

async function seedCorridor(seed) {
  const client = await pool.connect();
  const { corridor } = seed;
  try {
    await client.query('begin');
    await client.query(`
      insert into corridors (id, name, region, timezone, is_active)
      values ($1, $2, $3, $4, $5)
      on conflict (id) do update set name = excluded.name, region = excluded.region, timezone = excluded.timezone, is_active = excluded.is_active
    `, [corridor.id, corridor.name, corridor.region, corridor.timezone, corridor.is_active]);

    for (const stop of seed.stops) {
      await client.query(`
        insert into stops (stop_id, corridor_id, name, sequence_order, lat, lng, is_transfer_hub)
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (stop_id) do update set name = excluded.name, sequence_order = excluded.sequence_order, lat = excluded.lat, lng = excluded.lng, is_transfer_hub = excluded.is_transfer_hub
      `, [stop.stop_id, corridor.id, stop.stop_name, stop.sequence_order, stop.lat, stop.lng, stop.is_transfer_hub]);
    }

    for (const route of seed.routes) {
      await client.query(`
        insert into routes (route_id, corridor_id, route_short_name, route_long_name, mode, stop_ids)
        values ($1, $2, $3, $4, $5, $6::jsonb)
        on conflict (route_id) do update set route_short_name = excluded.route_short_name, route_long_name = excluded.route_long_name, mode = excluded.mode, stop_ids = excluded.stop_ids
      `, [route.route_id, corridor.id, route.route_short_name, route.route_long_name, route.mode, JSON.stringify(route.stop_ids)]);
    }

    for (const segment of seed.segments) {
      const from = seed.stops.find((stop) => stop.stop_id === segment.from_stop_id);
      const to = seed.stops.find((stop) => stop.stop_id === segment.to_stop_id);
      const geometry = { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] };
      await client.query(`
        insert into segments (segment_id, corridor_id, from_stop_id, to_stop_id, distance_km, baseline_duration_sec, polyline_geojson, route_geometry)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb, st_setsrid(st_makeline(st_makepoint($8, $9), st_makepoint($10, $11)), 4326))
        on conflict (segment_id) do update set distance_km = excluded.distance_km, baseline_duration_sec = excluded.baseline_duration_sec, polyline_geojson = excluded.polyline_geojson, route_geometry = excluded.route_geometry
      `, [segment.segment_id, corridor.id, segment.from_stop_id, segment.to_stop_id, segment.distance_km, segment.baseline_duration_sec, JSON.stringify(geometry), from.lng, from.lat, to.lng, to.lat]);
    }

    for (const schedule of seed.headway_schedules) {
      await client.query(`
        insert into headway_schedules (schedule_id, corridor_id, vehicle_type, start_time, end_time, headway_minutes, day_type)
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (schedule_id) do update set vehicle_type = excluded.vehicle_type, start_time = excluded.start_time, end_time = excluded.end_time, headway_minutes = excluded.headway_minutes, day_type = excluded.day_type
      `, [schedule.schedule_id, corridor.id, schedule.vehicle_type, schedule.start_time, schedule.end_time, schedule.headway_minutes, schedule.day_type]);
    }
    await client.query('commit');
    console.log(`Seeded ${seed.stops.length} stops, ${seed.segments.length} segments, and ${seed.headway_schedules.length} headway schedules into ${corridor.id}.`);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

try {
  if (!seeds.length) throw new Error('No active corridor seeds were found.');
  for (const seed of seeds) await seedCorridor(seed);
} finally {
  await pool.end();
}
