import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from '../src/server/session';

/**
 * The session token is the security boundary: `room.ts` overwrites the
 * `playerId` inside every incoming action with the one verified here, so if
 * verification can be talked into accepting a forged token, a player can act as
 * another player and read their cards.
 *
 * Set before any signing happens — the key is resolved lazily on first use.
 */
process.env.ROOM_SECRET = 'test-secret-not-a-real-one';

const NOW = 1_700_000_000_000;
const payload = { code: 'TEST', playerId: 'p2', name: 'Two', iat: NOW };

describe('session tokens', () => {
  it('round-trips the payload it was given', () => {
    expect(verifySession(signSession(payload), NOW)).toEqual(payload);
  });

  it('gives different tokens to different players', () => {
    const a = signSession({ ...payload, playerId: 'p1' });
    const b = signSession({ ...payload, playerId: 'p2' });
    expect(a).not.toBe(b);
    expect(verifySession(a, NOW)?.playerId).toBe('p1');
    expect(verifySession(b, NOW)?.playerId).toBe('p2');
  });

  it('rejects a payload edited after signing', () => {
    const token = signSession(payload);
    const [, signature] = token.split('.');

    // Re-encode the body with a different player and keep the old signature —
    // the shape a player would produce by hand-editing localStorage.
    const forgedBody = Buffer.from(
      JSON.stringify({ ...payload, playerId: 'p1', name: 'One' }),
    ).toString('base64url');

    expect(verifySession(`${forgedBody}.${signature}`, NOW)).toBeNull();
  });

  it('rejects an edited signature', () => {
    const token = signSession(payload);
    const [body, signature] = token.split('.');
    const flipped = `${signature!.slice(0, -1)}${signature!.at(-1) === 'A' ? 'B' : 'A'}`;
    expect(verifySession(`${body}.${flipped}`, NOW)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signSession(payload);
    const muchLater = NOW + 25 * 60 * 60 * 1000;
    expect(verifySession(token, NOW + 60_000)).not.toBeNull();
    expect(verifySession(token, muchLater)).toBeNull();
  });

  it('rejects a token dated in the future', () => {
    expect(verifySession(signSession({ ...payload, iat: NOW + 10 * 60_000 }), NOW)).toBeNull();
  });

  it('rejects anything that is not one of our tokens', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'nonsense',
      '.',
      '.signature-only',
      'body-only.',
      'a.b.c',
      // A syntactically valid pair of halves that simply is not signed by us.
      `${Buffer.from('{}').toString('base64url')}.${Buffer.from('nope').toString('base64url')}`,
    ]) {
      expect(verifySession(bad, NOW), `${String(bad)} must not verify`).toBeNull();
    }
  });

  it('rejects a correctly signed body that is not a session', () => {
    // Signed by us, so the signature passes — the shape check has to catch it,
    // or a hand-built payload could smuggle in a missing playerId.
    const junk = signSession({ code: 'TEST' } as never);
    expect(verifySession(junk, NOW)).toBeNull();
  });
});
