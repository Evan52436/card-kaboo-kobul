/**
 * The live RNG handed to the engine as `Ctx.rng`.
 *
 * The engine never reaches for randomness itself; it takes a `() => number` in
 * [0, 1). In the browser that has to come from `crypto`, because a shuffle from
 * `Math.random()` is both weaker and untestable — and this shuffle decides who
 * wins. See AGENTS.md §9.
 */
export function cryptoRng(): () => number {
  const buf = new Uint32Array(1);
  return () => {
    crypto.getRandomValues(buf);
    // 2^32, so the result is in [0, 1) exactly like Math.random.
    return (buf[0] ?? 0) / 4294967296;
  };
}

/** A short, unambiguous room code — read aloud across a table. See AGENTS.md §7. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeRoomCode(length = 4): string {
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ROOM_CODE_ALPHABET[(buf[i] ?? 0) % ROOM_CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Accept a room code the way a human types it, and reduce it to canonical form.
 *
 * A code is read aloud across a table and typed on a phone, so it arrives
 * lowercase, or with the hyphen someone wrote on a napkin, or with its spaces
 * intact. Everything outside the alphabet is dropped rather than rejected:
 * there is nothing to guess at, because a code that reduces to nothing simply
 * will not be found.
 *
 * `E`/`L`/`O` are NOT mapped onto their look-alikes. The alphabet omits both
 * members of every confusable pair, so a player who typed one has misread the
 * code, and inventing a mapping would silently send them to a different room.
 */
export function normalizeRoomCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const upper = raw.toUpperCase();
  let out = '';
  for (const ch of upper) {
    if (ROOM_CODE_ALPHABET.includes(ch)) out += ch;
  }
  return out;
}
