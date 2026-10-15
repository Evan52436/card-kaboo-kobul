import { cryptoRng } from '@/lib/random';
import { getStore } from '@/store';
import { getRealtime } from '@/realtime';
import { createRooms, type RoomDeps } from './room';

/**
 * The real wiring, and the only place a route handler gets it.
 *
 * Kept out of `room.ts` so that module stays free of `getStore()`/`getRealtime()`
 * and can be driven in tests with an injected store, realtime, clock and RNG.
 *
 * `getStore()` and `getRealtime()` are process singletons, so assembling this
 * per request is just a few field reads.
 */
export function roomDeps(): RoomDeps {
  return {
    store: getStore(),
    realtime: getRealtime(),
    now: () => Date.now(),
    rng: cryptoRng(),
  };
}

export function rooms() {
  return createRooms(roomDeps());
}
