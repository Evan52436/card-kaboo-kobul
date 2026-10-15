import type { Action } from '@/engine/types';
import { isRoomError, ROOM_ERROR_MESSAGES, SESSION_HEADER, type RoomError, type SyncResponse } from '@/protocol';
import { saveSession, type StoredSession } from './session';

/**
 * ============================================================================
 *  THE API CLIENT — the only place this app calls `fetch`
 * ============================================================================
 *  Every call resolves to a value or a `RoomError`; none of them throw. A
 *  refusal is an ordinary outcome here — a lost tap race is expected, and a
 *  dropped connection must not look different from a busy table — so no caller
 *  needs a try/catch to avoid a blank screen.
 *
 *  Importable from a client bundle: `@/protocol` is type-only plus a few string
 *  constants, and the session header is defined there precisely because both
 *  sides must agree on it.
 * ============================================================================
 */

const BASE = '/api/rooms';

/** A transport failure or a malformed body, dressed as a room error. */
function offline(): RoomError {
  return { ok: false, code: 'E_BUSY', message: ROOM_ERROR_MESSAGES.E_BUSY };
}

/** The body of `create` and `join`: a seat and the credential that proves it. */
interface Seated {
  code: string;
  playerId: string;
  token: string;
}

function isSeated(value: unknown): value is Seated {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.playerId === 'string' && typeof v.token === 'string';
}

/**
 * One request. Returns the parsed body, or a `RoomError` for every way it can
 * fail — including a body that does not look like what was asked for, which is
 * treated as a busy table rather than trusted.
 */
async function call(path: string, init: {
  method: string;
  body?: unknown;
  token?: string;
}): Promise<unknown | RoomError> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers[SESSION_HEADER] = init.token;

  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // Never from a cache: a stale projection is a player looking at a table
      // that has already moved on.
      cache: 'no-store',
    });
  } catch {
    return offline();
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return offline();
  }

  if (isRoomError(payload)) return payload;
  return response.ok ? payload : offline();
}

async function callSync(path: string, init: {
  method: string;
  body?: unknown;
  token?: string;
}): Promise<SyncResponse | RoomError> {
  const result = await call(path, init);
  if (isRoomError(result)) return result;
  const sync = result as Partial<SyncResponse>;
  // A response that is not a sync is treated as a failure rather than coerced:
  // `room` is the only field anything downstream can safely assume.
  if (typeof sync.room !== 'object' || sync.room === null) return offline();
  return { room: sync.room, events: sync.events ?? [], eventSeq: sync.eventSeq ?? 0 };
}

const room = (s: StoredSession) => `${BASE}/${encodeURIComponent(s.code)}`;

/** Mint a room and take seat 1, remembering the seat on this device. */
export async function createRoom(name: string): Promise<StoredSession | RoomError> {
  const result = await call(BASE, { method: 'POST', body: { name } });
  if (isRoomError(result)) return result;
  if (!isSeated(result)) return offline();
  const session: StoredSession = { code: result.code, playerId: result.playerId, name, token: result.token };
  saveSession(session);
  return session;
}

/** Take a seat in somebody else's room, given only the four characters. */
export async function joinRoom(code: string, name: string): Promise<StoredSession | RoomError> {
  const result = await call(`${BASE}/${encodeURIComponent(code)}/join`, {
    method: 'POST',
    body: { name },
  });
  if (isRoomError(result)) return result;
  if (!isSeated(result)) return offline();
  const session: StoredSession = { code: result.code, playerId: result.playerId, name, token: result.token };
  saveSession(session);
  return session;
}

/** The host deals. Everybody else is refused, and the refusal says no more than that. */
export function startRoom(session: StoredSession): Promise<SyncResponse | RoomError> {
  return callSync(`${room(session)}/start`, { method: 'POST', token: session.token });
}

/**
 * One move.
 *
 * `action.playerId` is sent for readability but is ignored: the server replaces
 * it from the session, because a request body is not allowed to say who you are.
 */
export function sendAction(session: StoredSession, action: Action): Promise<SyncResponse | RoomError> {
  return callSync(`${room(session)}/actions`, {
    method: 'POST',
    token: session.token,
    body: { action },
  });
}

/** This player's truth from `since` onward. The load, the poll, and the resync. */
export function readState(session: StoredSession, since: number): Promise<SyncResponse | RoomError> {
  return callSync(`${room(session)}/state?since=${since}`, { method: 'GET', token: session.token });
}

/** Give up the seat. Frees it before the deal; only marks it gone afterwards. */
export async function leaveRoom(session: StoredSession): Promise<{ ok: true } | RoomError> {
  const result = await call(`${room(session)}/leave`, { method: 'POST', token: session.token });
  // Anything that is not a refusal means the seat was given up.
  return isRoomError(result) ? result : { ok: true };
}

/**
 * A subscribe-only credential, or `null` when this deployment has no push
 * service. `null` is a normal answer, not a failure: the caller polls instead.
 */
export async function realtimeToken(session: StoredSession): Promise<unknown | null> {
  const result = await call(`${room(session)}/token`, { method: 'POST', token: session.token });
  if (isRoomError(result)) return null;
  const token = (result as { token?: unknown }).token;
  return token ?? null;
}
