import { isRoomError, SESSION_HEADER, type RoomError, type RoomErrorCode } from '@/protocol';
import { normalizeRoomCode } from '@/lib/random';

/**
 * ============================================================================
 *  THE HTTP EDGE — parsing in, status codes out
 * ============================================================================
 *  Route handlers are meant to be three lines each, so everything they share
 *  lives here rather than being repeated six times.
 *
 *  The one rule worth stating: **a rejection never explains itself.** Every
 *  failure leaves through `fail()`, carrying the generic sentence from
 *  `ROOM_ERROR_MESSAGES`. A specific reason is itself information — "you cannot
 *  do that while someone is mid-tap" tells you where a card is — so the client
 *  has nothing to branch on but the code, and the code only says whether to
 *  retry, resync or give up.
 * ============================================================================
 */

export { SESSION_HEADER };

const STATUS: Record<RoomErrorCode, number> = {
  E_NOT_FOUND: 404,
  E_ROOM_FULL: 409,
  E_ALREADY_STARTED: 409,
  E_BAD_SESSION: 401,
  E_BAD_REQUEST: 400,
  /** Not the client's fault and worth retrying, so it must not look like one. */
  E_BUSY: 503,
};

export function sessionOf(request: Request): string | null {
  return request.headers.get(SESSION_HEADER);
}

export function codeOf(raw: string): string {
  return normalizeRoomCode(raw);
}

/**
 * A body that is absent, empty or malformed is an EMPTY body, not a 500. The
 * caller's own validation then rejects it with the right code, which is one
 * error path instead of two.
 */
export async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `?since=` — a cursor the client owns. Anything unusable means "from the start". */
export function sinceOf(request: Request): number {
  const raw = new URL(request.url).searchParams.get('since');
  const value = raw === null ? 0 : Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function fail(error: RoomError): Response {
  return Response.json(error, { status: STATUS[error.code] });
}

/**
 * A success and a refusal are both 200.
 *
 * That is deliberate. A refused move still returns the fresh projection, which
 * is what tells the client its view was stale — so it is a useful answer, not
 * an error, and the loser of a tap race needs to receive it.
 */
export function reply<T extends object>(result: T | RoomError): Response {
  return isRoomError(result) ? fail(result) : Response.json(result, { status: 200 });
}
