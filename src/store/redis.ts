import { Redis } from '@upstash/redis';
import type { RoomRecord, StateStore } from './types';

/**
 * The Redis StateStore — Upstash, over REST, so it works from a Vercel function.
 *
 * This is the adapter that makes the game work across serverless instances,
 * i.e. across the internet. Without it each instance would have its own Map and
 * two players would quietly be in different rooms.
 */

/** Rooms are abandoned, not deleted. Long enough for a slow evening, short enough
 *  that a forgotten room cannot accumulate forever. Refreshed on every write. */
const TTL_SECONDS = 12 * 60 * 60;

const keyFor = (code: string) => `kaboo:room:${code}`;

/**
 * Compare-and-set in one atomic round trip.
 *
 * A read-then-write pair would be the obvious implementation and it would be
 * wrong: two simultaneous taps could both read `rev` 7, both decide they win,
 * and both write — producing two tap resolutions and no "too late". The tap
 * race is the one claim the whole design rests on, so the compare and the write
 * have to happen where nothing can interleave between them.
 *
 * KEYS[1] the room key; ARGV[1] expected rev; ARGV[2] the new record as JSON;
 * ARGV[3] the TTL. Returns 1 when it wrote, 0 when someone got there first.
 */
const CAS = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local ok, decoded = pcall(cjson.decode, cur)
if not ok then return 0 end
if tonumber(decoded['rev']) ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

export function createRedisStore(url: string, token: string): StateStore {
  const redis = new Redis({ url, token });

  return {
    async create(code, record) {
      // NX is the atomic half of this: two players racing to mint the same code
      // cannot both succeed, so the caller can retry with a fresh one.
      const result = await redis.set(keyFor(code), JSON.stringify(record), {
        nx: true,
        ex: TTL_SECONDS,
      });
      return result === 'OK';
    },

    async read(code) {
      // Upstash parses JSON on the way out when it can, but a value stored by
      // the Lua path may come back as the raw string. Accept both rather than
      // depend on which route wrote it.
      const raw = await redis.get<RoomRecord | string>(keyFor(code));
      if (raw === null || raw === undefined) return null;
      if (typeof raw === 'string') return JSON.parse(raw) as RoomRecord;
      return raw;
    },

    async commit(code, expected, next) {
      const written = await redis.eval(
        CAS,
        [keyFor(code)],
        [String(expected), JSON.stringify(next), String(TTL_SECONDS)],
      );
      if (Number(written) !== 1) return null;
      return next;
    },
  };
}
