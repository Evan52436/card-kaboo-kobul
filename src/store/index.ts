import type { StateStore } from './types';
import { createMemoryStore } from './memory';
import { createRedisStore } from './redis';
import { redisCredentialsFromEnv } from './env';

export type { RoomRecord, RosterEntry, RoomStatus, StateStore, QueuedEvent } from './types';
export { PENDING_LIMIT } from './types';

/**
 * Pick a store once per process.
 *
 * Redis needs a URL and a token together: a URL with no token is a
 * half-configured deployment, and silently falling back to memory there would
 * look like it works while quietly splitting players across instances. Instead
 * we use Redis only when it is fully configured and memory otherwise — which is
 * the documented behaviour in .env.example.
 *
 * Where the credentials come from (hand-set `UPSTASH_REDIS_REST_*`, or Vercel's
 * integration names under whatever prefix it chose) is `env.ts`'s business.
 *
 * The singleton lives on `globalThis` because Next's dev server re-evaluates
 * modules on every edit. A module-level `let` would hand each reload a fresh
 * empty Map, so the room a player just created would vanish the moment a file
 * was saved.
 */
const globalStore = globalThis as typeof globalThis & { __kabooStore?: StateStore };

export function getStore(): StateStore {
  if (globalStore.__kabooStore) return globalStore.__kabooStore;

  const credentials = redisCredentialsFromEnv(process.env);

  const store = credentials
    ? createRedisStore(credentials.url, credentials.token)
    : createMemoryStore();

  globalStore.__kabooStore = store;
  return store;
}

/** Test seam: a fresh in-memory store, unshared with anything else. */
export function createTestStore(): StateStore {
  return createMemoryStore();
}
