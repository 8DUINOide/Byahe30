import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const REPORT_TTL_MS = 90_000;
const SESSION_RETENTION_MS = 30 * 60_000;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function equalHash(left, right) {
  const a = Buffer.from(left || '', 'hex');
  const b = Buffer.from(right || '', 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function publicTrip(row) {
  return {
    trip_id: row.trip_id,
    corridor_id: row.corridor_id,
    route_id: row.route_id,
    vehicle_type: row.vehicle_type,
    direction: row.direction,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    accuracy_m: Number(row.accuracy_m),
    progress_km: Number(row.progress_km),
    observed_speed_mps: row.observed_speed_mps == null ? null : Number(row.observed_speed_mps),
    last_seen_at: new Date(row.last_seen_at).toISOString()
  };
}

export class LiveVehicleStore {
  constructor(pool = null) {
    this.pool = pool;
    this.trips = new Map();
  }

  async start({ corridorId, routeId, vehicleType, direction }) {
    const tripId = randomUUID();
    const reporterToken = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(reporterToken);
    const startedAt = new Date();
    if (this.pool) {
      await this.pool.query(`
        insert into live_vehicle_trips
          (trip_id, corridor_id, route_id, vehicle_type, direction, reporter_token_hash, started_at, last_seen_at)
        values ($1, $2, $3, $4, $5, $6, $7, $7)
      `, [tripId, corridorId, routeId, vehicleType, direction, tokenHash, startedAt]);
    } else {
      this.trips.set(tripId, {
        trip_id: tripId, corridor_id: corridorId, route_id: routeId,
        vehicle_type: vehicleType, direction, reporter_token_hash: tokenHash,
        started_at: startedAt.toISOString(), last_seen_at: startedAt.toISOString(),
        latitude: null, longitude: null, accuracy_m: null, progress_km: null,
        previous_progress_km: null, previous_position_at: null, observed_speed_mps: null
      });
    }
    return { trip_id: tripId, reporter_token: reporterToken };
  }

  async update(tripId, corridorId, reporterToken, position) {
    const tokenHash = hashToken(reporterToken);
    const now = new Date();
    if (this.pool) {
      const result = await this.pool.query(`
        update live_vehicle_trips
        set previous_progress_km = progress_km,
            previous_position_at = last_seen_at,
            observed_speed_mps = case
              when progress_km is not null
                and extract(epoch from ($9::timestamptz - last_seen_at)) > 2
                and abs((case when direction = 'reverse' then $8 - $7 else $7 end) - progress_km) * 1000 / extract(epoch from ($9::timestamptz - last_seen_at)) <= 40
              then abs((case when direction = 'reverse' then $8 - $7 else $7 end) - progress_km) * 1000 / extract(epoch from ($9::timestamptz - last_seen_at))
              else observed_speed_mps
            end,
            latitude = $4, longitude = $5, accuracy_m = $6,
            progress_km = case when direction = 'reverse' then $8 - $7 else $7 end,
            last_seen_at = $9
        where trip_id = $1 and corridor_id = $2 and reporter_token_hash = $3 and ended_at is null
        returning trip_id
      `, [tripId, corridorId, tokenHash, position.latitude, position.longitude, position.accuracy_m, position.forward_progress_km, position.corridor_distance_km, now]);
      return result.rowCount === 1;
    }

    const trip = this.trips.get(tripId);
    if (!trip || trip.corridor_id !== corridorId || !equalHash(trip.reporter_token_hash, tokenHash)) return false;
    const progressKm = trip.direction === 'reverse'
      ? position.corridor_distance_km - position.forward_progress_km
      : position.forward_progress_km;
    if (trip.latitude != null) {
      trip.previous_progress_km = trip.progress_km;
      trip.previous_position_at = trip.last_seen_at;
      const elapsedSec = (now.getTime() - new Date(trip.last_seen_at).getTime()) / 1000;
      const progressDeltaM = (progressKm - trip.progress_km) * 1000;
      const observed = elapsedSec > 2 ? progressDeltaM / elapsedSec : null;
      if (observed >= 0 && observed <= 40) trip.observed_speed_mps = observed;
    }
    const { forward_progress_km, corridor_distance_km, ...storedPosition } = position;
    Object.assign(trip, storedPosition, { progress_km: progressKm, last_seen_at: now.toISOString() });
    return true;
  }

  async getTripContext(tripId, corridorId, reporterToken) {
    const tokenHash = hashToken(reporterToken);
    if (this.pool) {
      const result = await this.pool.query(`
        select route_id, direction
        from live_vehicle_trips
        where trip_id = $1 and corridor_id = $2 and reporter_token_hash = $3 and ended_at is null
      `, [tripId, corridorId, tokenHash]);
      return result.rows[0] || null;
    }
    const trip = this.trips.get(tripId);
    if (!trip || trip.corridor_id !== corridorId || !equalHash(trip.reporter_token_hash, tokenHash)) return null;
    return { route_id: trip.route_id, direction: trip.direction };
  }

  async listActive(corridorId, now = new Date()) {
    if (this.pool) {
      await this.pool.query(`
        delete from live_vehicle_trips
        where ended_at is not null or last_seen_at < now() - interval '30 minutes'
      `);
      const result = await this.pool.query(`
        select trip_id, corridor_id, route_id, vehicle_type, direction,
               latitude, longitude, accuracy_m, progress_km, observed_speed_mps, last_seen_at
        from live_vehicle_trips
        where corridor_id = $1 and ended_at is null and latitude is not null
          and last_seen_at >= $2
        order by last_seen_at desc
      `, [corridorId, new Date(now.getTime() - REPORT_TTL_MS)]);
      return result.rows.map(publicTrip);
    }

    const staleBefore = now.getTime() - SESSION_RETENTION_MS;
    const activeBefore = now.getTime() - REPORT_TTL_MS;
    const active = [];
    for (const [tripId, trip] of this.trips) {
      const lastSeen = new Date(trip.last_seen_at).getTime();
      if (lastSeen < staleBefore) {
        this.trips.delete(tripId);
        continue;
      }
      if (trip.corridor_id !== corridorId || trip.latitude == null || lastSeen < activeBefore) continue;
      active.push(publicTrip(trip));
    }
    return active.sort((a, b) => new Date(b.last_seen_at) - new Date(a.last_seen_at));
  }

  async end(tripId, corridorId, reporterToken) {
    const tokenHash = hashToken(reporterToken);
    if (this.pool) {
      const result = await this.pool.query(
        'delete from live_vehicle_trips where trip_id = $1 and corridor_id = $2 and reporter_token_hash = $3',
        [tripId, corridorId, tokenHash]
      );
      return result.rowCount === 1;
    }
    const trip = this.trips.get(tripId);
    if (!trip || trip.corridor_id !== corridorId || !equalHash(trip.reporter_token_hash, tokenHash)) return false;
    this.trips.delete(tripId);
    return true;
  }
}

export function createLiveVehicleStore(telemetryStore) {
  return new LiveVehicleStore(telemetryStore?.pool || null);
}
