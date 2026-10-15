import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PlayerId } from '@/engine/types';

/**
 * ============================================================================
 *  SESSIONS — how a device proves which seat is its own
 * ============================================================================
 *  `base64url(payload).base64url(hmac)`, signed with ROOM_SECRET.
 *
 *  Signed rather than "a random string plus a lookup table" for two reasons:
 *  a session survives a Redis blip, and it carries the (room, player) pair that
 *  the Ably capability is scoped from, so the realtime token needs no extra
 *  round trip to the store.
 *
 *  This is the ONLY thing standing between a player and another player's cards:
 *  `room.ts` overwrites the `playerId` inside every incoming action with the
 *  one verified here, so a forged body cannot act as someone else. That makes
 *  verification the security boundary, and it is written to fail closed.
 * ============================================================================
 */

export interface SessionPayload {
  code: string;
  playerId: PlayerId;
  name: string;
  /** Issued at, epoch ms. */
  iat: number;
}

/** Long enough to resume after a phone sleeps overnight; the room expires first anyway. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The signing key, resolved once per process.
 *
 * With no ROOM_SECRET we mint a random one and warn. That is safe ONLY because
 * the in-memory store is the other half of the same unconfigured deployment and
 * it dies with this process too — the two fall back together. A production
 * deployment that sets Redis but forgets ROOM_SECRET would issue sessions no
 * other instance can verify, so that combination is refused outright below.
 *
 * Held on `globalThis` so Next's dev-server module reloads do not silently
 * rotate the key and log everyone out mid-game.
 */
const globalSecret = globalThis as typeof globalThis & { __kabooSecret?: string };

function secret(): string {
  if (globalSecret.__kabooSecret) return globalSecret.__kabooSecret;

  const fromEnv = process.env.ROOM_SECRET;
  if (fromEnv && fromEnv.length > 0) {
    globalSecret.__kabooSecret = fromEnv;
    return fromEnv;
  }

  const redisConfigured = Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );
  if (process.env.NODE_ENV === 'production' && redisConfigured) {
    throw new Error(
      'kaboo: ROOM_SECRET is required when a shared store is configured — ' +
        'otherwise each instance signs sessions no other instance can verify.',
    );
  }

  const minted = randomBytes(32).toString('hex');
  console.warn(
    'kaboo: ROOM_SECRET is unset; using a random per-process key. ' +
      'Sessions will not survive a restart. Set ROOM_SECRET before deploying.',
  );
  globalSecret.__kabooSecret = minted;
  return minted;
}

const b64 = (input: Buffer | string) => Buffer.from(input).toString('base64url');

function sign(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

export function signSession(payload: SessionPayload): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/**
 * Verify a token, returning its payload or `null`.
 *
 * `null` covers every failure — tampered, garbled, expired, wrong shape — and
 * the caller must not distinguish between them in a response. Which of those
 * happened is not the client's business, and saying so out loud is the kind of
 * detail that leaks.
 */
export function verifySession(token: string | null | undefined, now: number): SessionPayload | null {
  if (!token) return null;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(body);

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself be an oracle.
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const { code, playerId, name, iat } = parsed as Record<string, unknown>;
  if (typeof code !== 'string' || code.length === 0) return null;
  if (typeof playerId !== 'string' || playerId.length === 0) return null;
  if (typeof name !== 'string') return null;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  if (now - iat > MAX_AGE_MS) return null;
  // A token from the future is a clock problem or a forgery; reject either way.
  if (iat > now + 60_000) return null;

  return { code, playerId, name, iat };
}
