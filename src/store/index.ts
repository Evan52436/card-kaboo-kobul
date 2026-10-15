import type { StateStore } from './types';
import { createMemoryStore } from './memory';
import { createRedisStore } from './redis';

export type { RoomRecord, RosterEntry, RoomStatus, StateStore, QueuedEvent } from './types';
export { PENDING_LIMIT } from './types';

/**
 * Pick a store once per process.
 *
 * Both env vars are required together: a URL with no token is a
 * half-configured deployment, and silently falling back to memory there would
 * look like it works while quietly splitting players across instances. Instead
 * we use Redis only when it is fully configured and memory otherwise — which is
 * the documented behaviour in .env.example.
 *
 * The singleton lives on `globalThis` because Next's dev server re-evaluates
 * modules on every edit. A module-level `let` would hand each reload a fresh
 * empty Map, so the room a player just created would vanish the moment a file
 * was saved.
 */
const globalStore = globalThis as typeof globalThis & { __kabooStore?: StateStore };

export function getStore(): StateStore {
  if (globalStore.__kabooStore) return globalStore.__kabooStore;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  const store =
    url && token ? createRedisStore(url, token) : createMemoryStore();

  globalStore.__kabooStore = store;
  return store;
}

/** Test seam: a fresh in-memory store, unshared with anything else. */
export function createTestStore(): StateStore {
  return createMemoryStore();
}
