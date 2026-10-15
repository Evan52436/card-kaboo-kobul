import type { RoomRecord, StateStore } from './types';

/**
 * The in-memory StateStore: one Node process, one Map, no external services.
 *
 * This is what makes `npm run dev` and the whole test suite work with no Redis,
 * no accounts and no network. It is NOT a production store: on Vercel each
 * function instance has its own memory, so two players routed to different
 * instances would see different rooms. Redis exists for exactly that reason,
 * and `getStore()` picks it up automatically when the env vars are present.
 *
 * Everything handed out is a clone, and that is load-bearing rather than
 * defensive: if `read` returned the live object, a caller could mutate a hand
 * without ever calling `commit`, and the change would reach every other
 * player's projection with no version bump.
 */
export function createMemoryStore(): StateStore {
  const rooms = new Map<string, RoomRecord>();

  return {
    async create(code, record) {
      if (rooms.has(code)) return false;
      rooms.set(code, structuredClone(record));
      return true;
    },

    async read(code) {
      const record = rooms.get(code);
      return record ? structuredClone(record) : null;
    },

    async commit(code, expected, next) {
      const current = rooms.get(code);
      // A missing record is a lost race too: someone else's `create` won, or the
      // room expired. Either way this write must not land.
      if (!current || current.rev !== expected) return null;
      const stored = structuredClone(next);
      rooms.set(code, stored);
      return structuredClone(stored);
    },
  };
}
