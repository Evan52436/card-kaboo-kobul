import { describe, expect, it } from 'vitest';
import { redisCredentialsFromEnv } from '../src/store/env';

/**
 * Which Redis does the app talk to? Get this wrong and a correct Vercel deploy
 * silently runs on an in-process Map, splitting rooms across serverless
 * instances. These pin the lookup against the shapes the platform really uses.
 */

const URL = 'https://example-redis.upstash.io';
const TOKEN = 'write-token';

describe('redisCredentialsFromEnv', () => {
  it('uses the hand-set UPSTASH names', () => {
    expect(
      redisCredentialsFromEnv({
        UPSTASH_REDIS_REST_URL: URL,
        UPSTASH_REDIS_REST_TOKEN: TOKEN,
      }),
    ).toEqual({ url: URL, token: TOKEN });
  });

  it("finds Vercel's integration names under a custom prefix", () => {
    // Exactly what the integration injected for this project.
    expect(
      redisCredentialsFromEnv({
        STORAGEKOBUL_KV_REST_API_URL: URL,
        STORAGEKOBUL_KV_REST_API_TOKEN: TOKEN,
        STORAGEKOBUL_KV_REST_API_READ_ONLY_TOKEN: 'read-only-token',
        STORAGEKOBUL_KV_URL: 'rediss://tcp-url',
        STORAGEKOBUL_REDIS_URL: 'rediss://tcp-url',
      }),
    ).toEqual({ url: URL, token: TOKEN });
  });

  it('finds the unprefixed KV names', () => {
    expect(
      redisCredentialsFromEnv({ KV_REST_API_URL: URL, KV_REST_API_TOKEN: TOKEN }),
    ).toEqual({ url: URL, token: TOKEN });
  });

  it('lets the explicit UPSTASH names win over discovery', () => {
    expect(
      redisCredentialsFromEnv({
        UPSTASH_REDIS_REST_URL: 'https://explicit.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'explicit-token',
        STORAGEKOBUL_KV_REST_API_URL: URL,
        STORAGEKOBUL_KV_REST_API_TOKEN: TOKEN,
      }),
    ).toEqual({ url: 'https://explicit.upstash.io', token: 'explicit-token' });
  });

  it('never picks the read-only token: the store writes', () => {
    expect(
      redisCredentialsFromEnv({
        STORAGEKOBUL_KV_REST_API_URL: URL,
        STORAGEKOBUL_KV_REST_API_READ_ONLY_TOKEN: 'read-only-token',
      }),
    ).toBeNull();
  });

  it('ignores the TCP connection strings', () => {
    expect(
      redisCredentialsFromEnv({
        STORAGEKOBUL_KV_URL: 'rediss://tcp-url',
        STORAGEKOBUL_REDIS_URL: 'rediss://tcp-url',
      }),
    ).toBeNull();
  });

  it('needs a URL and a token together, never one alone', () => {
    expect(redisCredentialsFromEnv({ STORAGEKOBUL_KV_REST_API_URL: URL })).toBeNull();
    expect(redisCredentialsFromEnv({ STORAGEKOBUL_KV_REST_API_TOKEN: TOKEN })).toBeNull();
    expect(redisCredentialsFromEnv({ UPSTASH_REDIS_REST_URL: URL })).toBeNull();
    expect(redisCredentialsFromEnv({})).toBeNull();
  });

  it('treats empty strings as unset', () => {
    expect(
      redisCredentialsFromEnv({
        UPSTASH_REDIS_REST_URL: '',
        UPSTASH_REDIS_REST_TOKEN: '',
        STORAGEKOBUL_KV_REST_API_URL: URL,
        STORAGEKOBUL_KV_REST_API_TOKEN: TOKEN,
      }),
    ).toEqual({ url: URL, token: TOKEN });
    expect(
      redisCredentialsFromEnv({
        STORAGEKOBUL_KV_REST_API_URL: '',
        STORAGEKOBUL_KV_REST_API_TOKEN: '',
      }),
    ).toBeNull();
  });

  it("never pairs one integration's URL with another's token", () => {
    expect(
      redisCredentialsFromEnv({
        AAA_KV_REST_API_URL: 'https://a.upstash.io',
        BBB_KV_REST_API_TOKEN: 'b-token',
      }),
    ).toBeNull();
  });

  it('chooses deterministically when two integrations exist, whatever the key order', () => {
    const a = { AAA_KV_REST_API_URL: 'https://a.upstash.io', AAA_KV_REST_API_TOKEN: 'a-token' };
    const b = { BBB_KV_REST_API_URL: 'https://b.upstash.io', BBB_KV_REST_API_TOKEN: 'b-token' };
    const expected = { url: 'https://a.upstash.io', token: 'a-token' };

    expect(redisCredentialsFromEnv({ ...a, ...b })).toEqual(expected);
    expect(redisCredentialsFromEnv({ ...b, ...a })).toEqual(expected);
  });

  it('does not match a longer, unrelated name that merely ends the same way', () => {
    expect(
      redisCredentialsFromEnv({
        XKV_REST_API_URL: URL,
        XKV_REST_API_TOKEN: TOKEN,
      }),
    ).toBeNull();
  });
});
