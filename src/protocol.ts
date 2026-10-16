import type { Projection } from '@/engine/project';
import type { EngineEvent, PlayerId } from '@/engine/types';

/**
 * ============================================================================
 *  THE WIRE CONTRACT — the only thing the client and server both know
 * ============================================================================
 *  Everything here is type-only (no runtime imports), so this file is safe to
 *  pull into a client bundle. It is the seam that keeps `useGame` from knowing
 *  anything about Redis, Ably, or the engine's internals.
 *
 *  `room.ts` builds these, the route handlers return them, and the realtime
 *  adapters push them. One shape, so a move that arrives by push and a move
 *  that arrives by poll cannot be handled differently by accident.
 * ============================================================================
 */

/**
 * What one player is entitled to see, right now.
 *
 * Two shapes because the game has two states and they share no fields: before
 * the deal there are no hands at all, and after it there is no roster to show.
 * A single type with everything optional would make "lobby" and "playing" a
 * matter of runtime inspection at every render.
 */
export type RoomView =
  | {
      status: 'lobby';
      code: string;
      /** Who this device is. The client verifies this against its stored session. */
      you: PlayerId;
      /** Whether *you* are the host, for showing the deal button. */
      host: boolean;
      /**
       * Who the host is, for labelling somebody else's row. Sent rather than
       * inferred from `roster[0]`: that happens to be the host today, and a label
       * that is right only because of an ordering rule in `room.ts` is a label
       * that will be wrong the first time the ordering changes.
       */
      hostId: PlayerId;
      roster: { id: PlayerId; name: string; joinedAt: number }[];
      seats: number;
    }
  | {
      status: 'playing';
      code: string;
      you: PlayerId;
      host: boolean;
      /** Already projected for `you`. Never the raw GameState. */
      view: Projection;
    };

/**
 * A private event, with the sequence number that identifies it.
 *
 * The seq is not decoration. Push and poll are two independent paths to the same
 * fact, and the server deliberately sends the WHOLE queue on both — because it
 * does not know what the client has already seen. Without a per-event seq the
 * client cannot tell a replay from a replay of a replay, and a player would be
 * shown the same peek twice, or a poll would re-announce a card the push had
 * already delivered. With it, the client keeps one cursor and dedupes exactly.
 */
export type DeliveredEvent = EngineEvent & { seq: number };

/**
 * The response to every room read and every action, and the body of every
 * realtime push.
 *
 * `events` carries ONLY private events addressed to this player — a peek, the
 * card received in a Queen swap, the last card of the pile. Public events are
 * not repeated here because they already reach the client through
 * `RoomView.view.log`, and shipping the same fact twice is how one copy quietly
 * drifts into carrying more than it should.
 */
export interface SyncResponse {
  room: RoomView;
  events: DeliveredEvent[];
  /** Monotonic across the whole room. Pass the last value back as `since`. */
  eventSeq: number;
}

export type RoomErrorCode =
  | 'E_NOT_FOUND'
  | 'E_ROOM_FULL'
  | 'E_ALREADY_STARTED'
  | 'E_BAD_SESSION'
  | 'E_BAD_REQUEST'
  /** Compare-and-set kept losing; the client should simply try again. */
  | 'E_BUSY';

export interface RoomError {
  ok: false;
  code: RoomErrorCode;
  /**
   * Deliberately generic and identical in tone to the engine's.
   *
   * A rejection reason is itself information: "you cannot do that yet, someone
   * is mid-tap" tells you something about a hidden card's position. So no
   * response ever explains itself, and the client renders one flat message.
   */
  message: string;
}

export const ROOM_ERROR_MESSAGES: Record<RoomErrorCode, string> = {
  E_NOT_FOUND: 'That room is not open.',
  E_ROOM_FULL: 'That room is full.',
  E_ALREADY_STARTED: 'That game has already started.',
  E_BAD_SESSION: 'That seat is not yours.',
  E_BAD_REQUEST: 'That did not work.',
  E_BUSY: 'The table is busy. Try again.',
};

export function roomError(code: RoomErrorCode): RoomError {
  return { ok: false, code, message: ROOM_ERROR_MESSAGES[code] };
}

/**
 * Success types carry no `ok` field, so this is the only discriminator needed —
 * and it is the one the route handlers use to pick a status code.
 */
export function isRoomError(value: unknown): value is RoomError {
  return typeof value === 'object' && value !== null && (value as RoomError).ok === false;
}

/**
 * What the host may choose when they deal. The server keeps only these keys; a
 * request body does not get to set any other rule.
 */
export interface DealOptions {
  /** One deck (52 cards) or two shuffled together (104). Absent means one. */
  decks?: 1 | 2;
}

/** One private channel per player per room. Never a shared table channel. */
export function roomChannel(code: string, playerId: PlayerId): string {
  return `kaboo:room:${code}:p:${playerId}`;
}

/**
 * The session rides in a header, never a query string: a URL ends up in server
 * logs, browser history and `Referer` headers, and this token IS the seat.
 *
 * It lives here rather than in the server because both sides must agree on it
 * exactly, and a header name is part of the wire contract.
 */
export const SESSION_HEADER = 'x-kaboo-session';

/** The event name every push is published under. Shared so the two sides agree. */
export const SYNC_EVENT = 'sync';
