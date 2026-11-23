import { createApiServer } from './api.mjs';
import { createTelemetryStore } from './store/telemetry-store.mjs';
import { createLiveVehicleStore } from './store/live-vehicle-store.mjs';

const port = Number(process.env.PORT || 3000);
const telemetryStore = await createTelemetryStore();
const liveVehicleStore = createLiveVehicleStore(telemetryStore);
const server = createApiServer({ store: telemetryStore, liveVehicleStore });
server.listen(port, '0.0.0.0', () => {
  console.log(`Byahe30 listening on http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
