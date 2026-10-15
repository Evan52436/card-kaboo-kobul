import { createRooms } from '../src/server/room';
import { createMemoryStore } from '../src/store/memory';
import type { RoomRecord, StateStore } from '../src/store/types';
import { createMemoryRealtime, type MemoryRealtime } from '../src/realtime/memory';
import { isRoomError, type RoomError, type SyncResponse } from '../src/protocol';
import type { Action, PlayerId } from '../src/engine/types';
import { seededRng } from './helpers';

/**
 * A whole server, in one process, with no network.
 *
 * Every test in `room.test.ts` and `transport-game.test.ts` goes through this,
 * which is the payoff of keeping `room.ts` free of framework imports: the same
 * code path that serves a phone in another country is exercised here with an
 * injected clock and a seeded shuffle.
 */

export const T0 = 1_700_000_000_000;

export interface Seat {
  id: PlayerId;
  name: string;
  token: string;
}

export interface TestRoom {
  store: StateStore;
  realtime: MemoryRealtime;
  /** Move the virtual clock, which is how deadlines are crossed. */
  advance(ms: number): void;
  now(): number;
  create(name: string): Promise<{ code: string; seat: Seat }>;
  join(code: string, name: string): Promise<Seat>;
  start(code: string, token: string | null): Promise<SyncResponse>;
  act(
    code: string,
    token: string | null,
    action: Action,
  ): Promise<SyncResponse & { refusal?: { code: string } }>;
  /**
   * The same call without `must`. A whole-game driver needs to distinguish a
   * refused move (`refusal`) from a lost compare-and-set (`E_BUSY`, which it
   * retries) from a wrong-shaped request (which is a bug), so it cannot have the
   * harness turn all three into one thrown Error.
   */
  attempt(
    code: string,
    token: string | null,
    action: Action,
  ): Promise<(SyncResponse & { refusal?: { code: string } }) | RoomError>;
  /** `null` is a real case, not a mistake: it is how a client with no session asks. */
  read(code: string, token: string | null, since?: number): Promise<SyncResponse>;
  leave(code: string, token: string | null): Promise<{ ok: true }>;
  /** The raw record: the server's own truth, which no client ever sees. */
  record(code: string): Promise<RoomRecord | null>;
  /** Create, seat everyone, deal. The usual starting point. */
  deal(names: string[]): Promise<{ code: string; seats: Seat[] }>;
}

/** Narrow a result union, failing the test rather than letting `undefined` spread. */
export function must<T>(value: T | RoomError): T {
  if (isRoomError(value)) throw new Error(`unexpected refusal: ${value.code} — ${value.message}`);
  return value;
}

export function makeTestRoom(seed = 7): TestRoom {
  const store = createMemoryStore();
  const realtime = createMemoryRealtime();
  let clock = T0;

  const api = createRooms({
    store,
    realtime,
    now: () => clock,
    // One shared generator, so a shuffle is reproducible given the call order.
    rng: seededRng(seed),
  });

  const room: TestRoom = {
    store,
    realtime,
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,

    async create(name) {
      const created = must(await api.createRoom(name));
      return { code: created.code, seat: { id: created.playerId, name, token: created.token } };
    },

    async join(code, name) {
      const joined = must(await api.joinRoom(code, name));
      return { id: joined.playerId, name, token: joined.token };
    },

    async start(code, token) {
      return must(await api.startRoom(code, token));
    },

    async act(code, token, action) {
      return must(await api.act(code, token, action));
    },

    attempt: (code, token, action) => api.act(code, token, action),

    async read(code, token, since = 0) {
      return must(await api.read(code, token, since));
    },

    async leave(code, token) {
      return must(await api.leaveRoom(code, token));
    },

    record: (code) => store.read(code),

    async deal(names) {
      const [host, ...rest] = names;
      if (!host) throw new Error('deal() needs at least one name');
      const { code, seat } = await room.create(host);
      const seats = [seat];
      for (const name of rest) seats.push(await room.join(code, name));
      await room.start(code, seats[0]!.token);
      return { code, seats };
    },
  };

  return room;
}

/** Every card id visible anywhere in a payload, by shape. Re-exported for tests. */
export { visibleCardIds, hiddenCardIds } from './invariants';
