/**
 * Where do the Redis credentials live?
 *
 * Two places, because there are two ways to get an Upstash database:
 *
 *  1. By hand: `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. These win
 *     when both are set, so an explicit choice always overrides discovery.
 *
 *  2. From Vercel's Upstash integration, which injects `<PREFIX>_KV_REST_API_URL`
 *     and `<PREFIX>_KV_REST_API_TOKEN`. The prefix is chosen at install time
 *     (`STORAGEKOBUL_…` for this project), so it cannot be hard-coded. We match on
 *     the suffix instead, so the integration works without renaming anything in
 *     the Vercel dashboard.
 *
 * Why this exists: with only the first form recognised, a perfectly correct
 * Vercel deploy would silently fall back to the in-process Map. That looks fine
 * for one player and quietly splits rooms across serverless instances.
 *
 * Three details keep discovery safe:
 *  - The URL and token must share a prefix. If two integrations ever exist, we
 *    never pair one's URL with the other's token.
 *  - Only `KV_REST_API_TOKEN` is accepted. The integration also injects a
 *    `…_KV_REST_API_READ_ONLY_TOKEN`, which ends differently and is never matched:
 *    the store writes, so a read-only token would fail on every commit.
 *  - Keys are visited in sorted order, so the choice does not depend on the
 *    order the platform happened to list the environment in.
 *
 * Pure on purpose: it takes the environment as an argument so a test can hand it
 * any shape without touching `process.env`.
 */

export type Env = Record<string, string | undefined>;

export interface RedisCredentials {
  url: string;
  token: string;
}

const URL_NAME = 'KV_REST_API_URL';
const TOKEN_NAME = 'KV_REST_API_TOKEN';

export function redisCredentialsFromEnv(env: Env): RedisCredentials | null {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url, token };

  for (const key of Object.keys(env).sort()) {
    // `KV_REST_API_URL` itself, or `<PREFIX>_KV_REST_API_URL`. Requiring the
    // underscore stops a longer unrelated name from matching by accident.
    if (key !== URL_NAME && !key.endsWith(`_${URL_NAME}`)) continue;

    const prefix = key.slice(0, key.length - URL_NAME.length); // '' or 'PREFIX_'
    const foundUrl = env[key];
    const foundToken = env[`${prefix}${TOKEN_NAME}`];
    if (foundUrl && foundToken) return { url: foundUrl, token: foundToken };
  }

  return null;
}
