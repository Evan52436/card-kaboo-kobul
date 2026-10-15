import type { PlayerId } from '@/engine/types';

/**
 * The seat, as remembered by this device — and the store React reads it through.
 *
 * The session token is the ONLY thing that proves which player this browser is,
 * so it is what makes a refresh, a reconnect or a suspended tab survivable. There
 * are no accounts: losing this blob means losing the seat, and a player who loses
 * it rejoins as somebody new.
 *
 * It lives in `localStorage`, which makes it EXTERNAL state, so it is read with
 * `useSyncExternalStore` rather than copied into `useState` by an effect. A copy
 * would be a second source of truth, and the effect that made it would render
 * once with the wrong answer — which for a seated player means a visible flash of
 * the join form.
 */

const KEY = 'kaboo.session';

export interface StoredSession {
  code: string;
  playerId: PlayerId;
  name: string;
  token: string;
}

/** Parse a raw blob, rejecting anything that is not a complete seat. */
function parse(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const s = parsed as Record<string, unknown>;
    if (
      typeof s.code !== 'string' ||
      typeof s.playerId !== 'string' ||
      typeof s.name !== 'string' ||
      typeof s.token !== 'string'
    ) {
      return null;
    }
    return { code: s.code, playerId: s.playerId, name: s.name, token: s.token };
  } catch {
    return null;
  }
}

/**
 * `localStorage` throws rather than returning null in a private window with site
 * data blocked, and in some embedded webviews it is absent entirely. A game that
 * cannot start because a convenience could not be read would be a poor trade, so
 * a failure here degrades to "this device remembers nothing", which is exactly
 * the state a first-time visitor is in.
 */
function raw(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * The cached snapshot.
 *
 * `useSyncExternalStore` compares snapshots by identity on every render, so
 * parsing the blob each time would return a fresh object forever and spin. The
 * raw string is the cache key, which also makes a write in another tab visible
 * as a changed snapshot.
 */
let seenRaw: string | null = null;
let seenValue: StoredSession | null = null;

export function sessionSnapshot(): StoredSession | null {
  const current = raw();
  if (current !== seenRaw) {
    seenRaw = current;
    seenValue = parse(current);
  }
  return seenValue;
}

const listeners = new Set<() => void>();

/** Tell every mounted reader that the seat changed. */
function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Subscribe to the seat.
 *
 * The `storage` event is what keeps two tabs on one machine honest: a player who
 * leaves in one tab must not stay seated in the other, because the seat is a
 * property of the device, not of the tab.
 */
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function saveSession(session: StoredSession): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(session));
    announce();
  } catch {
    // Nothing to do about it, and nothing worth telling the player: the game
    // works, they just will not be recognised after a refresh.
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // As above.
  }
  // Announced regardless, so the reader re-checks the device rather than trusting
  // a cache. If storage is so blocked that the token survives, so be it — that is
  // the truth of this device, and the server has already been told to drop the
  // seat.
  announce();
}
