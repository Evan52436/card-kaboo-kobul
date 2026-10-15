import { applyAction, startGame, tick } from '@/engine/reduce';
import { project } from '@/engine/project';
import { MAX_PLAYERS, MIN_PLAYERS } from '@/engine/state';
import type { Action, EngineError, EngineEvent, PlayerId } from '@/engine/types';
import { makeRoomCode } from '@/lib/random';
import { PENDING_LIMIT, type RoomRecord, type StateStore } from '@/store';
import type { Realtime } from '@/realtime';
import {
  isRoomError,
  roomError,
  type RoomError,
  type RoomView,
  type SyncResponse,
} from '@/protocol';
import { signSession, verifySession, type SessionPayload } from './session';

/**
 * ============================================================================
 *  THE ROOM — every use case, and the only place that touches IO
 * ============================================================================
 *  Framework-free on purpose: the route handlers are three lines each and this
 *  module is driven directly by tests, with an injected store, realtime, clock
 *  and RNG. No `fetch`, no HTTP, no `Date.now()` reached for directly.
 *
 *  Two rules run through all of it:
 *
 *  * **The session decides who you are.** The `playerId` in an incoming action
 *    is discarded and replaced with the one the signed token proves. A player
 *    cannot act as another player by editing a request body.
 *  * **Every write is compare-and-set.** Read, decide, commit against the
 *    revision you read; on conflict re-read and decide again. That is what
 *    turns two simultaneous taps into one winner and one "too late".
 * ============================================================================
 */

export interface RoomDeps {
  store: StateStore;
  realtime: Realtime;
  now: () => number;
  rng: () => number;
}

/** A response plus, when the engine refused, the reason — with the current state. */
export interface ActionResult extends SyncResponse {
  refusal?: EngineError;
}

export interface CreatedRoom {
  code: string;
  token: string;
  playerId: PlayerId;
}

export interface JoinedRoom {
  code: string;
  token: string;
  playerId: PlayerId;
}

const ROOM_CODE_LENGTH = 4;
const CODE_ATTEMPTS = 6;
/** Enough to absorb a real race, few enough that a pathological one gives up. */
const CAS_ATTEMPTS = 8;
const NAME_MAX = 12;

type Outcome<T> = { next: RoomRecord; value: T } | { error: RoomError };
/** `changed` says whether a write actually landed, so a no-op need not be pushed. */
type Mutation<T> = { record: RoomRecord; value: T; changed: boolean } | { error: RoomError };

/** Trim, cap and reject empty. React escapes whatever is left, so no markup risk. */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, NAME_MAX);
  return trimmed.length > 0 ? trimmed : null;
}

export function createRooms(deps: RoomDeps) {
  const ctx = () => ({ now: deps.now(), rng: deps.rng });

  /**
   * Read, decide, commit against the revision we read — and on conflict, read
   * again and decide again.
   *
   * The retry is not a nicety: it is where a lost tap race becomes a correct
   * `E_TOO_LATE`. A second tap that committed against a stale revision backs
   * off, re-reads, sees the tap already claimed, and its re-decision is refused
   * by the engine for the right reason.
   */
  async function mutate<T>(
    code: string,
    change: (record: RoomRecord, now: number) => Outcome<T>,
  ): Promise<Mutation<T>> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const current = await deps.store.read(code);
      if (!current) return { error: roomError('E_NOT_FOUND') };

      const now = deps.now();
      const outcome = change(current, now);
      if ('error' in outcome) return outcome;

      // Nothing changed: skip the write entirely, so a poll with nothing to say
      // costs a read and no CAS at all.
      if (outcome.next.rev === current.rev) {
        return { record: current, value: outcome.value, changed: false };
      }

      const committed = await deps.store.commit(code, current.rev, outcome.next);
      if (committed) return { record: committed, value: outcome.value, changed: true };
    }
    return { error: roomError('E_BUSY') };
  }

  /** What one player is entitled to see, right now. Never the raw state. */
  function viewFor(record: RoomRecord, playerId: PlayerId): RoomView {
    const host = record.hostId === playerId;
    if (record.status === 'lobby' || !record.state) {
      return {
        status: 'lobby',
        code: record.code,
        you: playerId,
        host,
        hostId: record.hostId,
        roster: record.roster.map((r) => ({ id: r.id, name: r.name, joinedAt: r.joinedAt })),
        seats: MAX_PLAYERS,
      };
    }
    return {
      status: 'playing',
      code: record.code,
      you: playerId,
      host,
      view: project(record.state, playerId),
    };
  }

  /**
   * The sync payload for one player.
   *
   * `since` filters the queue to what this client has not confirmed. The client
   * is the authority on that — it advances its cursor from pushes as well as
   * from responses — which is exactly why a dropped push is recoverable: the
   * cursor never moved, so the next read still returns the card.
   *
   * Every event carries its own `seq`, because this payload is delivered over
   * two independent paths. A push sends `since = 0` (the server does not know
   * where the client is), so without the seq a client could not tell an already
   * seen peek from a new one.
   */
  function syncFor(record: RoomRecord, playerId: PlayerId, since: number): SyncResponse {
    return {
      room: viewFor(record, playerId),
      events: (record.pending[playerId] ?? [])
        .filter((e) => e.seq > since)
        .map((e) => ({ ...e.event, seq: e.seq })),
      eventSeq: record.eventSeq,
    };
  }

  /**
   * Push the new truth to everyone except the player who will get it in their
   * own HTTP response. Best-effort: `publish` cannot throw, because the action
   * is already committed and a failed push must not look like a failed move.
   *
   * The recipient's `since` is unknown here, so they get their whole queue; the
   * client's own cursor discards anything it has already seen. That is what
   * keeps a push and a poll from double-reporting the same peek.
   */
  async function fanOut(record: RoomRecord, except: PlayerId | null): Promise<void> {
    const recipients = record.roster.filter((r) => r.id !== except);
    if (recipients.length === 0) return;
    await deps.realtime.publish(
      record.code,
      recipients.map((r) => ({ playerId: r.id, message: syncFor(record, r.id, 0) })),
    );
  }

  /** The verified session, or the reason there is not one. */
  function authenticate(code: string, token: string | null): SessionPayload | RoomError {
    const session = verifySession(token, deps.now());
    // The code is part of the signed payload, so a token minted for one room
    // cannot be replayed against another.
    if (!session || session.code !== code) return roomError('E_BAD_SESSION');
    return session;
  }

  function inRoster(record: RoomRecord, playerId: PlayerId): boolean {
    return record.roster.some((r) => r.id === playerId);
  }

  return {
    /** Mint a room and take seat 1. Retries if the code is already taken. */
    async createRoom(rawName: unknown): Promise<CreatedRoom | RoomError> {
      const name = cleanName(rawName);
      if (name === null) return roomError('E_BAD_REQUEST');

      const now = deps.now();
      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
        const code = makeRoomCode(ROOM_CODE_LENGTH);
        const playerId: PlayerId = 'p1';
        const record: RoomRecord = {
          code,
          status: 'lobby',
          roster: [{ id: playerId, name, joinedAt: now }],
          hostId: playerId,
          state: null,
          rev: 1,
          pending: {},
          eventSeq: 0,
          createdAt: now,
          updatedAt: now,
        };
        if (await deps.store.create(code, record)) {
          return { code, token: signSession({ code, playerId, name, iat: now }), playerId };
        }
      }
      return roomError('E_BUSY');
    },

    /** Take the next free seat. Seat order is join order, which is the turn ring. */
    async joinRoom(code: string, rawName: unknown): Promise<JoinedRoom | RoomError> {
      const name = cleanName(rawName);
      if (name === null) return roomError('E_BAD_REQUEST');

      const outcome = await mutate<string>(code, (record, now) => {
        if (record.status !== 'lobby') return { error: roomError('E_ALREADY_STARTED') };
        if (record.roster.length >= MAX_PLAYERS) return { error: roomError('E_ROOM_FULL') };

        // Ids are derived from the roster length and are never reused, so a
        // player who drops and rejoins cannot inherit somebody's seat.
        const playerId: PlayerId = `p${record.roster.length + 1}`;
        const next: RoomRecord = {
          ...record,
          rev: record.rev + 1,
          roster: [...record.roster, { id: playerId, name, joinedAt: now }],
          updatedAt: now,
        };
        return { next, value: playerId };
      });

      if ('error' in outcome) return outcome.error;

      const playerId = outcome.value;
      await fanOut(outcome.record, playerId);
      return {
        code,
        playerId,
        token: signSession({ code, playerId, name, iat: deps.now() }),
      };
    },

    /** Host only. This is the moment the roster freezes and the engine takes over. */
    async startRoom(code: string, token: string | null): Promise<SyncResponse | RoomError> {
      const session = authenticate(code, token);
      if (isRoomError(session)) return session;

      const outcome = await mutate<SyncResponse>(code, (record, now) => {
        if (record.status !== 'lobby') return { error: roomError('E_ALREADY_STARTED') };
        if (record.hostId !== session.playerId) return { error: roomError('E_BAD_SESSION') };
        if (record.roster.length < MIN_PLAYERS) return { error: roomError('E_BAD_REQUEST') };

        // The engine has no join action: the roster is handed over complete.
        const state = startGame(
          code,
          record.roster.map((r) => ({ id: r.id, name: r.name })),
          ctx(),
        );
        const next: RoomRecord = {
          ...record,
          status: 'playing',
          state,
          rev: record.rev + 1,
          updatedAt: now,
        };
        return { next, value: syncFor(next, session.playerId, 0) };
      });

      if ('error' in outcome) return outcome.error;
      await fanOut(outcome.record, session.playerId);
      return outcome.value;
    },

    /**
     * Apply one action. This is the tap race.
     *
     * `applyAction` runs deadlines itself before dispatching, so a single call
     * both advances the clock and resolves the move. It can also return an
     * error *and* `versionChanged: true` — a deadline fired while the action was
     * refused — and in that case the moved state must still be written, or the
     * timeout is silently lost.
     */
    async act(
      code: string,
      token: string | null,
      incoming: Action,
    ): Promise<ActionResult | RoomError> {
      const session = authenticate(code, token);
      if (isRoomError(session)) return session;

      // The body's playerId is discarded outright: the token says who you are.
      const action = { ...incoming, playerId: session.playerId } as Action;

      const outcome = await mutate<ActionResult>(code, (record, now) => {
        if (record.status !== 'playing' || !record.state) {
          return { error: roomError('E_BAD_REQUEST') };
        }
        if (!inRoster(record, session.playerId)) return { error: roomError('E_BAD_SESSION') };

        const result = applyAction(record.state, action, ctx());

        let seq = record.eventSeq;
        const pending: Record<PlayerId, { seq: number; event: EngineEvent }[]> = {
          ...record.pending,
        };
        for (const event of result.events) {
          // PUBLIC events carry no face and already reach clients through
          // `view.log`, so the queue holds only what was addressed to one player.
          const to = event.to;
          if (typeof to !== 'string') continue;
          seq += 1;
          const queue = pending[to] ?? [];
          pending[to] = [...queue, { seq, event }].slice(-PENDING_LIMIT);
        }

        const queued = seq !== record.eventSeq;
        const next: RoomRecord = {
          ...record,
          state: result.state,
          pending,
          eventSeq: seq,
          rev: result.versionChanged || queued ? record.rev + 1 : record.rev,
          updatedAt: result.versionChanged || queued ? now : record.updatedAt,
        };

        const value: ActionResult = { ...syncFor(next, session.playerId, 0) };
        if (result.error) value.refusal = result.error;
        return { next, value };
      });

      if ('error' in outcome) return outcome.error;
      // Only news if the write actually landed — a refused action that moved
      // nothing has nothing to tell the other players.
      if (outcome.changed) await fanOut(outcome.record, session.playerId);
      return outcome.value;
    },

    /**
     * Read this player's truth. Used for the first load, for every poll, and to
     * resync after a reconnect or a suspended tab.
     *
     * Deadlines resolve HERE. A serverless function cannot hold a timer, so the
     * clock only advances when somebody touches the room — which is why the
     * client keeps polling even while its push channel is healthy.
     */
    async read(code: string, token: string | null, since: number): Promise<SyncResponse | RoomError> {
      const session = authenticate(code, token);
      if (isRoomError(session)) return session;

      const outcome = await mutate<SyncResponse>(code, (record, now) => {
        if (!inRoster(record, session.playerId)) return { error: roomError('E_BAD_SESSION') };

        let state = record.state;
        if (state) {
          const ticked = tick(state, ctx());
          if (ticked?.versionChanged) state = ticked.state;
        }

        // Delivery is tracked by the client's cursor, not here. Dropping what
        // it has already seen is garbage collection, not bookkeeping — so this
        // can never lose an event the client still needs.
        const queue = record.pending[session.playerId] ?? [];
        const keep = queue.filter((e) => e.seq > since);
        const stateMoved = state !== record.state;
        const collected = keep.length !== queue.length;

        const next: RoomRecord = {
          ...record,
          state,
          pending: { ...record.pending, [session.playerId]: keep },
          rev: stateMoved || collected ? record.rev + 1 : record.rev,
          updatedAt: stateMoved || collected ? now : record.updatedAt,
        };
        return { next, value: syncFor(next, session.playerId, since) };
      });

      if ('error' in outcome) return outcome.error;
      return outcome.value;
    },

    /**
     * Mark a player gone. The seat is never freed: the turn ring is fixed and
     * the engine autoplays a disconnected player's turn rather than stalling.
     */
    async leaveRoom(code: string, token: string | null): Promise<{ ok: true } | RoomError> {
      const session = authenticate(code, token);
      if (isRoomError(session)) return session;

      const outcome = await mutate<{ ok: true }>(code, (record, now) => {
        if (!inRoster(record, session.playerId)) return { error: roomError('E_BAD_SESSION') };

        // Before the deal there is nothing to preserve, so the seat goes back.
        if (record.status === 'lobby') {
          const roster = record.roster.filter((r) => r.id !== session.playerId);
          if (roster.length === 0) {
            // Last one out. The room is simply abandoned; it expires on its own.
            return { next: { ...record, rev: record.rev + 1, roster, updatedAt: now }, value: { ok: true } };
          }
          const hostId = record.hostId === session.playerId ? roster[0]!.id : record.hostId;
          return {
            next: { ...record, rev: record.rev + 1, roster, hostId, updatedAt: now },
            value: { ok: true },
          };
        }

        const result = applyAction(record.state!, { type: 'LEAVE', playerId: session.playerId }, ctx());
        const next: RoomRecord = {
          ...record,
          state: result.state,
          rev: record.rev + 1,
          updatedAt: now,
        };
        return { next, value: { ok: true } };
      });

      if ('error' in outcome) return outcome.error;
      await fanOut(outcome.record, session.playerId);
      return { ok: true };
    },

    /**
     * A subscribe-only credential for this player's own channel, or `null` when
     * this deployment has no push service at all.
     *
     * `null` is a 200, not an error. Running without Ably is a supported
     * configuration — the client polls instead — so "there is no push channel"
     * is an answer, not a rejection. Making it a 400 would blame the client for
     * a choice the server made.
     */
    async realtimeToken(code: string, token: string | null): Promise<{ token: unknown | null } | RoomError> {
      const session = authenticate(code, token);
      if (isRoomError(session)) return session;
      return { token: await deps.realtime.tokenFor(code, session.playerId) };
    },
  };
}
