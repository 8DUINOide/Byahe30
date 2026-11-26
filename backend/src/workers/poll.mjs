import { listSeeds, loadSeedById } from '../config.mjs';
import { createTelemetryStore } from '../store/telemetry-store.mjs';
import { runPollingCycle } from './telemetry.mjs';

const seeds = process.env.BYAHE30_CORRIDOR_ID
  ? [await loadSeedById(process.env.BYAHE30_CORRIDOR_ID)]
  : (await listSeeds()).filter((seed) => seed.corridor.is_active);
const store = await createTelemetryStore();
for (const seed of seeds) {
  const result = await runPollingCycle({ seed, store });
  console.log(JSON.stringify({ corridor_id: seed.corridor.id, ...result }, null, 2));
}
