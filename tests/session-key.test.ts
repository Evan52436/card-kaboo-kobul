import { describe, expect, it } from 'vitest';
import { sessionKeyFromEnv } from '../src/server/sessionKey';

/**
 * Every serverless instance has to pick the same session key, or a token minted
 * by one is rejected by the next and the player is kicked from the room.
 */

const REDIS = {
  STORAGEKOBUL_KV_REST_API_URL: 'https://example-redis.upstash.io',
  STORAGEKOBUL_KV_REST_API_TOKEN: 'write-token',
  STORAGEKOBUL_KV_REST_API_READ_ONLY_TOKEN: 'read-only-token',
};

describe('sessionKeyFromEnv', () => {
  it('uses ROOM_SECRET when it is set', () => {
    expect(sessionKeyFromEnv({ ROOM_SECRET: 's3cret', ...REDIS })).toEqual({
      key: 's3cret',
      source: 'ROOM_SECRET',
    });
  });

  it("derives a key from the Redis token when there is no ROOM_SECRET", () => {
    const resolved = sessionKeyFromEnv(REDIS);
    expect(resolved?.source).toBe('REDIS_TOKEN');
    expect(resolved?.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives the same key on every instance', () => {
    // Two separate "instances", each reading the same shared token.
    expect(sessionKeyFromEnv({ ...REDIS })).toEqual(sessionKeyFromEnv({ ...REDIS }));
  });

  it('gives a different key for a different token', () => {
    const other = { ...REDIS, STORAGEKOBUL_KV_REST_API_TOKEN: 'another-token' };
    expect(sessionKeyFromEnv(other)?.key).not.toBe(sessionKeyFromEnv(REDIS)?.key);
  });

  it('does not use the token itself as the key', () => {
    expect(sessionKeyFromEnv(REDIS)?.key).not.toBe('write-token');
  });

  it('never derives from the read-only token', () => {
    expect(
      sessionKeyFromEnv({
        STORAGEKOBUL_KV_REST_API_URL: REDIS.STORAGEKOBUL_KV_REST_API_URL,
        STORAGEKOBUL_KV_REST_API_READ_ONLY_TOKEN: 'read-only-token',
      }),
    ).toBeNull();
  });

  it('treats an empty ROOM_SECRET as unset', () => {
    expect(sessionKeyFromEnv({ ROOM_SECRET: '', ...REDIS })?.source).toBe('REDIS_TOKEN');
  });

  it('returns null when nothing is configured, leaving the caller to mint a per-process key', () => {
    expect(sessionKeyFromEnv({})).toBeNull();
  });
});
