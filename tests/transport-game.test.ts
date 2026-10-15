import { describe, expect, it } from 'vitest';
import type { Projection } from '../src/engine/project';
import type { PlayerId } from '../src/engine/types';
import { hiddenCardIds, visibleCardIds } from './invariants';
import { isRoomError, type SyncResponse } from '../src/protocol';
import { chooseMove } from './decide';
import { makeTestRoom, type Seat, type TestRoom } from './room-helpers';

/**
 * ============================================================================
 *  THE TRANSPORT, UNDER A WHOLE GAME — the load-bearing test
 * ============================================================================
 *  `room.test.ts` proves the transport is correct on individual moves. This file
 *  proves it cannot DEADLOCK, which is a different and much easier thing to get
 *  wrong: every rule here is about a *sequence* of moves.
 *
 *  A turn can stall because the projection omitted a field a player needs, or
 *  because a write was refused and nothing retried it, or because a deadline
 *  never resolved with no timer to resolve it. None of that is visible from
 *  testing one action — it only appears when somebody plays eight players to the
 *  end of a round and the game stops responding.
 *
 *  Two invariants are enforced on EVERY game played here, not in a separate
 *  spot-check:
 *
 *  1. **A refusal is never the transport's fault.** If a player's own projection
 *     advertised a move, the engine may refuse it for exactly two reasons —
 *     `E_TOO_LATE` / `E_STALE`, the tap race being lost — and nothing else. Any
 *     other refusal means the projection lied to a client, which in the real app
 *     is a button that does nothing.
 *  2. **Nothing hidden crosses the wire.** Audited response-by-response against
 *     the server state that produced each one.
 * ============================================================================
 */

/** A lost race, and nothing else, is a legitimate refusal of an advertised move. */
const RACE_CODES = new Set(['E_TOO_LATE', 'E_STALE']);

interface Table {
  room: TestRoom;
  code: string;
  seats: Seat[];
}

async function seatTable(players: number, seed: number): Promise<Table> {
  const room = makeTestRoom(seed);
  const names = Array.from({ length: players }, (_, i) => `P${i + 1}`);
  const { code, seats } = await room.deal(names);
  return { room, code, seats };
}

function projectionOf(sync: SyncResponse): Projection {
  if (sync.room.status !== 'playing') throw new Error('expected a game, got a lobby');
  return sync.room.view;
}

interface Progress {
  steps: number;
  phase: string;
  stuck: string | null;
  taps: { accepted: number; offTurn: number; refused: number };
  /** Set when auditing: how many responses were walked, and how many hidden cards existed. */
  audit: { responses: number; hiddenSeen: number };
}

interface PlayOptions {
  maxSteps?: number;
  /**
   * Poll one seat at a time, reading the server record after each response.
   * Slower, and the only way the audit below is sound: with parallel polls
   * several seats' reads interleave and each may tick the clock, so the record
   * left behind is not necessarily the state any given response was built from.
   */
  audit?: boolean;
}

/**
 * Play the table to the end of the game, every player acting purely off their
 * own projection and reaching the server only through `room.ts`.
 */
async function playOut(t: Table, options: PlayOptions = {}): Promise<Progress> {
  const maxSteps = options.maxSteps ?? 900;
  const progress: Progress = {
    steps: 0,
    phase: 'peek',
    stuck: null,
    taps: { accepted: 0, offTurn: 0, refused: 0 },
    audit: { responses: 0, hiddenSeen: 0 },
  };

  async function pollSeat(seat: Seat): Promise<SyncResponse> {
    const sync = await t.room.read(t.code, seat.token);
    if (options.audit) {
      // Sequential, so the record read here is the state this response was
      // built from — which is what makes the check mean anything.
      const state = (await t.room.record(t.code))?.state;
      if (state) {
        const hidden = hiddenCardIds(state, seat.id);
        progress.audit.responses += 1;
        progress.audit.hiddenSeen += hidden.size;
        const leaked = [...visibleCardIds(sync.room)].filter((id) => hidden.has(id));
        expect(leaked, `${seat.id} was sent ${leaked.join(', ')}`).toEqual([]);
      }
      // A private event is the one place a face is allowed to travel, so the
      // routing is the property that matters, not the contents.
      for (const event of sync.events) expect(event.to).toBe(seat.id);
    }
    return sync;
  }

  let idle = 0;

  for (; progress.steps < maxSteps; progress.steps += 1) {
    const views = new Map<PlayerId, Projection>();
    if (options.audit) {
      for (const seat of t.seats) views.set(seat.id, projectionOf(await pollSeat(seat)));
    } else {
      const pairs = await Promise.all(
        t.seats.map(async (s) => [s.id, projectionOf(await pollSeat(s))] as const),
      );
      for (const [id, view] of pairs) views.set(id, view);
    }

    const first = [...views.values()][0]!;
    progress.phase = first.phase;
    if (first.phase === 'gameOver') return progress;

    let accepted = false;

    // When the pile is tappable, everyone at the table reaches for it — so try
    // the players who are NOT on turn first. Turning that around would let the
    // turn player's DRAW rob the table of every tap, and the off-turn path this
    // file exists to exercise would quietly never run.
    const tappable = first.canTap && !first.tap;
    const order = tappable
      ? [...t.seats].sort((a, b) => Number(a.id === first.turnPlayerId) - Number(b.id === first.turnPlayerId))
      : t.seats;

    for (const seat of order) {
      const view = views.get(seat.id)!;
      const move = chooseMove(view, seat.id);
      if (!move) continue;

      const offTurn = move.type === 'TAP' && view.turnPlayerId !== seat.id;
      const result = await t.room.attempt(t.code, seat.token, move);

      if (isRoomError(result)) {
        // A lost compare-and-set is not a verdict on the move. The next pass
        // re-reads and decides again, which is the whole retry design.
        if (result.code === 'E_BUSY') continue;
        throw new Error(`transport refused ${move.type} for ${seat.id}: ${result.code}`);
      }

      if (result.refusal) {
        if (!RACE_CODES.has(result.refusal.code)) {
          throw new Error(
            `projection advertised ${move.type} for ${seat.id} but the engine refused: ${result.refusal.code}`,
          );
        }
        if (move.type === 'TAP') progress.taps.refused += 1;
        continue; // let another seat try; the race was simply lost
      }

      if (move.type === 'TAP') {
        progress.taps.accepted += 1;
        if (offTurn) progress.taps.offTurn += 1;
      }
      accepted = true;
      break;
    }

    if (accepted) {
      idle = 0;
      continue;
    }

    // Nobody could act. Deadlines are the only thing that can move the game
    // now, and they only resolve when somebody touches the room — so touch it.
    idle += 1;
    if (idle > 4) {
      progress.stuck = first.phase;
      return progress;
    }
    t.room.advance(120_000);
  }

  progress.stuck = `step limit (${maxSteps})`;
  return progress;
}

/**
 * Play until the discard is tappable, without tapping.
 *
 * Setup for the contested-tap test, which needs a live tap window to race for.
 * Returns null if the game ended first.
 */
async function reachATap(
  t: Table,
  steps = 400,
): Promise<{ discardSeq: number; turnId: PlayerId } | null> {
  for (let i = 0; i < steps; i += 1) {
    const views = new Map<PlayerId, Projection>();
    for (const seat of t.seats) {
      views.set(seat.id, projectionOf(await t.room.read(t.code, seat.token)));
    }

    const first = [...views.values()][0]!;
    if (first.phase === 'reveal' || first.phase === 'gameOver') return null;
    if (first.canTap && !first.tap && first.turnPlayerId) {
      return { discardSeq: first.discardSeq, turnId: first.turnPlayerId };
    }

    const actor = t.seats.find((s) => s.id === first.turnPlayerId) ?? t.seats[0]!;
    const move = chooseMove(views.get(actor.id)!, actor.id);
    if (move) await t.room.attempt(t.code, actor.token, move);
    else t.room.advance(120_000);
  }
  return null;
}

describe('a game plays to the end through the transport alone', () => {
  /**
   * These games are genuinely heavy: every step polls each seat, and each poll
   * clones and re-projects the whole room. The memory store is a dev-and-test
   * convenience, so that cost is an artifact of the harness rather than of the
   * design — but it is real, so the slow cases carry their own budget instead of
   * inflating the default for the rest of the suite.
   */
  const SLOW = 120_000;

  it('reaches the reveal at every table size the brief allows', { timeout: SLOW }, async () => {
    for (const players of [2, 3, 4, 5, 6, 7, 8]) {
      const t = await seatTable(players, 4000 + players);
      const progress = await playOut(t);

      expect(progress.stuck, `${players} players stalled in ${progress.phase}`).toBeNull();
      expect(['reveal', 'gameOver'], `${players} players ended in ${progress.phase}`).toContain(
        progress.phase,
      );
      expect(progress.steps, `${players} players ground to the step limit`).toBeLessThan(900);
    }
  });

  it('scores the round it played, through the projection', { timeout: SLOW }, async () => {
    const t = await seatTable(4, 777);
    const progress = await playOut(t);
    expect(progress.stuck).toBeNull();

    const sync = await t.room.read(t.code, t.seats[0]!.token);
    const view = projectionOf(sync);
    expect(view.log.some((e) => e.kind === 'roundEnd'), 'the round must have been scored').toBe(true);
    expect(view.discardCount, 'a round of Kaboo must have produced a discard pile').toBeGreaterThan(0);
  });

  it('lets a player who is not on turn win a tap', { timeout: SLOW }, async () => {
    // The race is the point of the game, and it is only reachable at all if the
    // projection ships `canTap` and `discardSeq` to everyone, not just the actor.
    let offTurn = 0;
    for (const seed of [11, 22, 33, 44]) {
      const t = await seatTable(3, seed);
      const progress = await playOut(t);
      expect(progress.stuck, `seed ${seed} stalled in ${progress.phase}`).toBeNull();
      offTurn += progress.taps.offTurn;
    }
    expect(offTurn, 'four games never produced an off-turn tap').toBeGreaterThan(0);
  });

  it('settles contested taps as wins and losses, never as errors', { timeout: SLOW }, async () => {
    // `playOut` tolerates a lost race but never produces one — it stops at the
    // first success — so the losing branch would go untested if this file only
    // played games. Here two players tap the same discard in the same tick,
    // through the transport, exactly as two phones would.
    let contested = 0;
    for (const seed of [5, 15, 25, 35, 45, 55]) {
      const t = await seatTable(4, seed);
      const opening = await reachATap(t);
      expect(opening, `seed ${seed} never produced a tappable discard`).not.toBeNull();
      const { discardSeq, turnId } = opening!;

      const tappers = t.seats.filter((s) => s.id !== turnId);
      expect(tappers.length).toBeGreaterThan(1);

      const results = await Promise.all(
        tappers.map((s) => t.room.attempt(t.code, s.token, { type: 'TAP', playerId: s.id, seenSeq: discardSeq })),
      );

      // Narrow once, explicitly: `filter` cannot carry a type predicate, and a
      // transport-level error here is a bug worth failing on rather than
      // silently reclassifying as a lost race.
      const settled = results.map((r) => {
        if (isRoomError(r)) throw new Error(`seed ${seed}: transport refused a tap: ${r.code}`);
        return r;
      });
      const wins = settled.filter((r) => !r.refusal);
      const losses = settled.filter((r) => r.refusal);

      expect(wins, `seed ${seed}: exactly one tap may win`).toHaveLength(1);
      expect(losses.length, `seed ${seed}: the rest must be told too late`).toBe(tappers.length - 1);
      for (const loss of losses) {
        expect(RACE_CODES.has(loss.refusal!.code), `seed ${seed}: ${loss.refusal!.code}`).toBe(true);
      }

      // The race is decided by whose write landed, so the state must agree.
      const state = (await t.room.record(t.code))!.state!;
      expect(state.tap?.playerId).toBe(wins[0]!.room.you);
      contested += 1;
    }
    expect(contested).toBe(6);
  });
});

describe('the wire stays closed for a whole game', () => {
  it('never hands any player a card they may not see, move after move', async () => {
    const t = await seatTable(3, 20261016);
    const progress = await playOut(t, { audit: true });

    expect(progress.stuck, `stalled in ${progress.phase}`).toBeNull();
    // Guard the guard: if the audit never ran, or never ran while anything was
    // hidden, "no leaks" would be true and worthless.
    expect(progress.audit.responses, 'the audit saw no responses').toBeGreaterThan(200);
    expect(progress.audit.hiddenSeen, 'nothing was ever hidden to leak').toBeGreaterThan(0);
  });
});

describe('a device is not the seat', () => {
  it('rebuilds the same view from a cold start, mid-game', async () => {
    // This is reconnection, which the brief makes mandatory: the phone is
    // refreshed, the app has nothing cached, and the token alone must restore
    // the same seat with the same information.
    const t = await seatTable(3, 909);
    const seat = t.seats[1]!;

    // Play a little so the state is not the opening deal.
    for (let i = 0; i < 12; i += 1) {
      const sync = await t.room.read(t.code, seat.token);
      const view = projectionOf(sync);
      const move = chooseMove(view, seat.id);
      if (move) await t.room.attempt(t.code, seat.token, move);
      else t.room.advance(120_000);
    }

    // A brand-new client: no cursor, no cache, nothing but the stored token.
    const cold = await t.room.read(t.code, seat.token, 0);
    const warm = await t.room.read(t.code, seat.token, 0);
    expect(cold.room.you).toBe(seat.id);
    expect(projectionOf(cold)).toEqual(projectionOf(warm));

    // And it is not a dead view — the restored seat can still play.
    const view = projectionOf(cold);
    const move = chooseMove(view, seat.id);
    if (move) {
      const result = await t.room.attempt(t.code, seat.token, move);
      expect(isRoomError(result) ? result.code : (result.refusal?.code ?? null)).toBeNull();
    }
  });

  it('shows two devices on one seat exactly the same table', async () => {
    const t = await seatTable(2, 313);
    const token = t.seats[0]!.token;
    const phone = await t.room.read(t.code, token, 0);
    const laptop = await t.room.read(t.code, token, 0);
    expect(projectionOf(laptop)).toEqual(projectionOf(phone));
  });
});

describe('the transport survives a client that never stops polling', () => {
  it('does not grow the room on a read that changes nothing', async () => {
    // Polling is the heartbeat that resolves deadlines, so it runs constantly.
    // If a no-op read rewrote the room, every phone would fight every other
    // phone for the compare-and-set and the table would thrash.
    const t = await seatTable(2, 4);
    const seat = t.seats[0]!;

    const first = await t.room.read(t.code, seat.token, 0);
    const rev = (await t.room.record(t.code))!.rev;

    for (let i = 0; i < 5; i += 1) await t.room.read(t.code, seat.token, first.eventSeq);

    expect((await t.room.record(t.code))!.rev).toBe(rev);
  });

  it('resolves a deadline on the poll of any player, not just the one it concerns', async () => {
    const t = await seatTable(3, 8);
    const deadline = (await t.room.record(t.code))!.state!.peekDeadline;
    t.room.advance(deadline - t.room.now() + 1);

    // The player whose turn it is NOT does the polling.
    const sync = await t.room.read(t.code, t.seats[2]!.token);
    expect(projectionOf(sync).phase).toBe('turnStart');
  });
});
