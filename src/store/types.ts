import type { EngineEvent, GameState, PlayerId } from '@/engine/types';

/**
 * ============================================================================
 *  THE ROOM — the thing the engine does not model
 * ============================================================================
 *  The engine's roster is fixed at `createGame` and it has no JOIN action, so
 *  it cannot represent "five people are in a room and two more are on the way".
 *  A `RoomRecord` is that missing layer: who has arrived, whether the game has
 *  begun, and the authoritative `GameState` once it has.
 *
 *  This lives on the SERVER only. It holds the deck order, so it must never be
 *  serialised toward a client — `project()` is the only path out.
 * ============================================================================
 */

export interface RosterEntry {
  id: PlayerId;
  name: string;
  joinedAt: number;
}

export type RoomStatus = 'lobby' | 'playing';

/**
 * A private event plus the sequence number it was assigned.
 *
 * The sequence is what makes delivery recoverable: the client keeps the highest
 * value it has seen and passes it back as `since`, so an event that a dropped
 * push never delivered is simply still greater than the cursor and gets
 * returned by the next read. Delivery does not have to be tracked server-side,
 * which is the only reason a push can safely be best-effort.
 */
export interface QueuedEvent {
  seq: number;
  event: EngineEvent;
}

export interface RoomRecord {
  code: string;
  status: RoomStatus;
  /** Join order is seat order: the engine assigns `seat` by array index. */
  roster: RosterEntry[];
  hostId: PlayerId;
  /** `null` until the host deals. Server-only: contains every hand and the deck. */
  state: GameState | null;
  /**
   * The compare-and-set token for THIS record.
   *
   * Deliberately not `state.version`: a join commits before any state exists,
   * and `status`/`pending` change without the engine moving at all. Naming it
   * `rev` rather than `version` keeps it from being confused with the engine's
   * own counter, which is a different thing entirely.
   */
  rev: number;
  /**
   * Transient reveals addressed to a player but not yet collected.
   *
   * A peek is an event, not stored state — but if the push is dropped, the
   * player has permanently lost a look the rules granted them. Queueing closes
   * that hole: `read(code, token, since)` hands back everything above the
   * client's cursor, so polling, a reconnect or a suspended tab all still get
   * the card.
   */
  pending: Record<PlayerId, QueuedEvent[]>;
  /** Monotonic; clients pass the last value they saw as `since`. */
  eventSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface StateStore {
  /** `false` when that code is already taken — used to mint a fresh one. */
  create(code: string, record: RoomRecord): Promise<boolean>;
  read(code: string): Promise<RoomRecord | null>;
  /**
   * Write `next` only if the stored record is still at `expected`.
   *
   * Returns the stored record, or `null` when another writer got there first.
   * `null` is not an error — it is the tap race resolving, and the caller must
   * re-read and re-decide rather than retry the same bytes.
   */
  commit(code: string, expected: number, next: RoomRecord): Promise<RoomRecord | null>;
}

/** How many undelivered events we keep per player before dropping the oldest. */
export const PENDING_LIMIT = 50;
