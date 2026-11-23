import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readdir } from 'node:fs/promises';

export const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT_ROOT = path.resolve(BACKEND_DIR, '..');
export const SEED_PATH = path.join(PROJECT_ROOT, 'data', 'gtfs', 'baao-naga', 'seed.json');
export const FRONTEND_DIR = path.join(PROJECT_ROOT, 'frontend');
export const TELEMETRY_PATH = path.join(PROJECT_ROOT, 'data', 'telemetry', 'logs.jsonl');
export const TIME_ZONE = 'Asia/Manila';

export async function loadSeed(pathname = SEED_PATH) {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(pathname, 'utf8'));
}

export async function loadSeedById(corridorId) {
  if (typeof corridorId !== 'string' || !/^[a-z0-9-]+$/.test(corridorId)) {
    throw Object.assign(new Error('Invalid corridor id'), { code: 'EINVAL' });
  }
  const pathname = path.join(PROJECT_ROOT, 'data', 'gtfs', corridorId, 'seed.json');
  const seed = await loadSeed(pathname);
  if (seed.corridor.id !== corridorId) throw Object.assign(new Error('Corridor id does not match its seed file'), { code: 'EINVAL' });
  return seed;
}

export async function listSeeds() {
  const directory = path.join(PROJECT_ROOT, 'data', 'gtfs');
  const entries = await readdir(directory, { withFileTypes: true });
  const seeds = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try { return await loadSeedById(entry.name); } catch { return null; }
  }));
  return seeds.filter(Boolean);
}
