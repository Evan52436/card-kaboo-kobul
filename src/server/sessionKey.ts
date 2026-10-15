import { createHmac } from 'node:crypto';
import { redisCredentialsFromEnv, type Env } from '../store/env';

/**
 * Which key signs the session tokens?
 *
 * Every serverless instance must answer this the same way. A session minted by
 * one instance is verified by whichever instance serves the next request, so if
 * two instances hold different keys, a player is "signed out" by the very next
 * poll that lands elsewhere. That looked like being kicked from the room a few
 * seconds into a game.
 *
 *  1. `ROOM_SECRET`, when set: a dedicated key, the right choice for the long run.
 *  2. Otherwise, when Redis is configured: derived from the Redis token. Every
 *     instance reads the same token, so every instance derives the same key, and
 *     nothing has to be set in the hosting dashboard. HMAC with a fixed label
 *     makes the key independent of the token itself: it cannot be used to
 *     recover the token.
 *  3. Otherwise `null`: the caller mints a random per-process key, which is only
 *     safe because the in-memory store it pairs with also dies with the process.
 *
 * The trade-off of (2): one secret now serves two purposes. If the Redis token
 * leaked, an attacker could forge sessions, but they could already read and
 * write every room directly, so nothing new is exposed.
 *
 * Pure: takes the environment as an argument so a test can hand it any shape.
 */
export type SessionKey = { key: string; source: 'ROOM_SECRET' | 'REDIS_TOKEN' };

const DERIVATION_LABEL = 'kaboo:session-key:v1';

export function sessionKeyFromEnv(env: Env): SessionKey | null {
  const explicit = env.ROOM_SECRET;
  if (explicit) return { key: explicit, source: 'ROOM_SECRET' };

  const redis = redisCredentialsFromEnv(env);
  if (redis) {
    const key = createHmac('sha256', redis.token).update(DERIVATION_LABEL).digest('hex');
    return { key, source: 'REDIS_TOKEN' };
  }

  return null;
}
