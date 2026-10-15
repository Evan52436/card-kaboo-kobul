import { describe, expect, it } from 'vitest';
import type { Projection } from '../src/engine/project';
import type { Action, PlayerId } from '../src/engine/types';
import { hiddenCardIds, visibleCardIds } from './invariants';
import { makeTestRoom, type Seat, type TestRoom } from './room-helpers';

/**
 * ============================================================================
 *  THE TRANSPORT — rooms, seats, and the race the whole design rests on
 * ============================================================================
 *  Everything here goes through `room.ts`, which is exactly what a route
 *  handler calls. The store, realtime, clock and RNG are injected, so these
 *  tests need no Redis, no Ably, no network and no real time.
 *
 *  Three claims worth reading twice:
 *
 *  * **The tap race.** Two players tap against the same revision; exactly one
 *    wins and the other is told "too late". This is the reason the store has a
 *    compare-and-set at all, and it went unexercised until this file existed.
 *  * **The session is the identity.** A player cannot act as another player by
 *    putting a different id in the request body.
 *  * **The wire carries no hidden face.** Checked against the shape of the
 *    whole payload, not against the fields we happen to remember.
 * ============================================================================
 */

/** One action for the player whose turn it is, from their own projection. */
function turnMove(view: Projection, actorId: PlayerId): Action | null {
  if (view.turnPlayerId !== actorId) return null;
  const legal = view.legalActions;
  const slot = view.players.find((p) => p.id === actorId)?.hand.find((s) => s.occupied)?.index;

  if (legal.includes('DRAW')) {
    return { type: 'DRAW', playerId: actorId, from: view.discardTop ? 'discard' : 'deck' };
  }
  if (legal.includes('SWAP') && slot !== undefined) return { type: 'SWAP', playerId: actorId, slot };
  if (legal.includes('DISCARD')) return { type: 'DISCARD', playerId: actorId };
  return null;
}

/**
 * Play until somebody could tap the pile, without ever tapping.
 *
 * This is setup for the race tests: they need a live tap window to race for.
 */
async function reachATap(
  room: TestRoom,
  code: string,
  seats: Seat[],
): Promise<{ discardSeq: number; turnId: PlayerId } | null> {
  for (let step = 0; step < 600; step += 1) {
    const record = await room.record(code);
    const state = record?.state;
    if (!state) return null;
    if (state.phase === 'reveal' || state.phase === 'gameOver') return null;

    const turnId = state.players[state.turnSeat]!.id;
    const actor = seats.find((s) => s.id === turnId);
    if (!actor) return null;

    const sync = await room.read(code, actor.token);
    if (sync.room.status !== 'playing') return null;
    const view = sync.room.view;

    if (view.phase === 'peek') {
      // Let the peek clock expire rather than fiddling with each seat by hand.
      room.advance(60_000);
      continue;
    }
    if (view.canTap && !view.tap) return { discardSeq: view.discardSeq, turnId };

    const move = turnMove(view, actor.id);
    if (move) await room.act(code, actor.token, move);
    else room.advance(120_000);
  }
  return null;
}

describe('rooms and seats', () => {
  it('creates a room, seats the creator, and deals once everyone is in', async () => {
    const room = makeTestRoom();
    const { code, seat } = await room.create('Ana');
    expect(code).toHaveLength(4);
    expect(seat.id).toBe('p1');

    const lobby = await room.read(code, seat.token);
    expect(lobby.room.status).toBe('lobby');
    if (lobby.room.status !== 'lobby') throw new Error('expected a lobby');
    expect(lobby.room.host).toBe(true);
    expect(lobby.room.seats).toBe(8);
    expect(lobby.room.roster.map((r) => r.name)).toEqual(['Ana']);

    await room.join(code, 'Bo');
    const dealt = await room.start(code, seat.token);
    expect(dealt.room.status).toBe('playing');
    if (dealt.room.status !== 'playing') throw new Error('expected a game');
    expect(dealt.room.view.phase).toBe('peek');
    expect(dealt.room.view.round).toBe(1);
  });

  it('refuses a ninth player and a second start', async () => {
    const room = makeTestRoom();
    const { code, seat } = await room.create('p1');
    for (let i = 2; i <= 8; i += 1) await room.join(code, `p${i}`);
    await expect(room.join(code, 'p9')).rejects.toThrow(/E_ROOM_FULL/);

    await room.start(code, seat.token);
    await expect(room.join(code, 'Late')).rejects.toThrow(/E_ALREADY_STARTED/);
    await expect(room.start(code, seat.token)).rejects.toThrow(/E_ALREADY_STARTED/);
  });

  it('only the host can deal, and only to a table of at least two', async () => {
    const room = makeTestRoom();
    const { code, seat } = await room.create('Ana');
    await expect(room.start(code, seat.token)).rejects.toThrow(/E_BAD_REQUEST/);

    const bo = await room.join(code, 'Bo');
    await expect(room.start(code, bo.token)).rejects.toThrow(/E_BAD_SESSION/);
    await expect(room.start(code, seat.token)).resolves.toBeTruthy();
  });

  it('gives each seat its own token, and the token names that seat', async () => {
    const room = makeTestRoom();
    const { code, seats } = await room.deal(['Ana', 'Bo']);
    expect(seats.map((s) => s.id)).toEqual(['p1', 'p2']);
    expect(seats[0]!.token).not.toBe(seats[1]!.token);

    for (const seat of seats) {
      const sync = await room.read(code, seat.token);
      expect(sync.room.you).toBe(seat.id);
    }
  });
});

describe('the session is the identity', () => {
  it('ignores a playerId forged into the action body', async () => {
    const room = makeTestRoom();
    const { code, seats } = await room.deal(['Ana', 'Bo']);
    const [ana, bo] = seats;
    const turnId = (await room.record(code))!.state!.players[(await room.record(code))!.state!.turnSeat]!.id;
    expect(turnId).toBe('p2');

    // Ana is not on turn and claims to be Bo. The engine must see Ana.
    const forged: Action = { type: 'DRAW', playerId: bo!.id, from: 'deck' };
    const result = await room.act(code, ana!.token, forged);
    expect(result.refusal?.code).toBeDefined();

    // And nothing moved: it is still Bo's turn, and no card was drawn.
    const after = (await room.record(code))!.state!;
    expect(after.players[after.turnSeat]!.id).toBe('p2');
    expect(after.drawn).toBeNull();
  });

  it('rejects a token minted for a different room', async () => {
    const room = makeTestRoom();
    const a = await room.deal(['Ana', 'Bo']);
    const b = await room.deal(['Cy', 'Di']);
    await expect(room.read(b.code, a.seats[0]!.token)).rejects.toThrow(/E_BAD_SESSION/);
  });

  it('rejects a tampered or missing token', async () => {
    const room = makeTestRoom();
    const { code, seats } = await room.deal(['Ana', 'Bo']);
    const token = seats[0]!.token;
    const tampered = `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`;
    await expect(room.read(code, tampered)).rejects.toThrow(/E_BAD_SESSION/);
    await expect(room.read(code, null)).rejects.toThrow(/E_BAD_SESSION/);
  });
});

describe('the tap race', () => {
  it('settles two simultaneous taps into one winner and one "too late"', async () => {
    const room = makeTestRoom(21);
    const { code, seats } = await room.deal(['Ana', 'Bo', 'Cy']);

    const opening = await reachATap(room, code, seats);
    expect(opening, 'never reached a tappable discard in 600 steps').not.toBeNull();
    const { discardSeq, turnId } = opening!;

    const tappers = seats.filter((s) => s.id !== turnId);
    expect(tappers).toHaveLength(2);

    // Both taps are issued against the revision they were shown, and the two
    // calls interleave inside `mutate` — so both read the same revision before
    // either commits. That is the race, not an approximation of it.
    const results = await Promise.all([
      room.act(code, tappers[0]!.token, { type: 'TAP', playerId: tappers[0]!.id, seenSeq: discardSeq }),
      room.act(code, tappers[1]!.token, { type: 'TAP', playerId: tappers[1]!.id, seenSeq: discardSeq }),
    ]);

    const accepted = results.filter((r) => !r.refusal);
    const refused = results.filter((r) => r.refusal);

    expect(accepted, 'exactly one tap may win').toHaveLength(1);
    expect(refused, 'the other tap must lose').toHaveLength(1);
    expect(refused[0]!.refusal!.code).toBe('E_TOO_LATE');
    expect(accepted[0]!.room.you).toBe(tappers[0]!.id);

    // The state recorded the winner, and the write landed exactly once.
    expect((await room.record(code))!.state!.tap?.playerId).toBe(tappers[0]!.id);
  });

  it('says "too late" whichever order the two taps arrive in', async () => {
    // Same race, resolved sequentially. Both taps are still built from one
    // revision — which is what a slow network does to two near-simultaneous
    // taps, and why a stale `seenSeq` must not be the thing that saves us.
    const room = makeTestRoom(33);
    const { code, seats } = await room.deal(['Ana', 'Bo', 'Cy']);
    const opening = await reachATap(room, code, seats);
    expect(opening).not.toBeNull();
    const { discardSeq, turnId } = opening!;

    const tappers = seats.filter((s) => s.id !== turnId).reverse();
    const first = await room.act(code, tappers[0]!.token, {
      type: 'TAP',
      playerId: tappers[0]!.id,
      seenSeq: discardSeq,
    });
    const second = await room.act(code, tappers[1]!.token, {
      type: 'TAP',
      playerId: tappers[1]!.id,
      seenSeq: discardSeq,
    });

    expect(first.refusal).toBeUndefined();
    expect(second.refusal?.code).toBe('E_TOO_LATE');
    expect((await room.record(code))!.state!.tap?.playerId).toBe(tappers[0]!.id);
  });

  it('refuses a tap built from a discard that has since changed', async () => {
    const room = makeTestRoom(45);
    const { code, seats } = await room.deal(['Ana', 'Bo']);
    const opening = await reachATap(room, code, seats);
    expect(opening).not.toBeNull();

    const actor = seats.find((s) => s.id !== opening!.turnId)!;
    const result = await room.act(code, actor.token, {
      type: 'TAP',
      playerId: actor.id,
      seenSeq: opening!.discardSeq + 1,
    });
    expect(result.refusal?.code).toBe('E_STALE');
  });
});

describe('nothing leaks through the wire', () => {
  it('never puts a hidden card in any player\'s sync payload', async () => {
    const room = makeTestRoom(11);
    const { code, seats } = await room.deal(['Ana', 'Bo', 'Cy']);

    for (let step = 0; step < 40; step += 1) {
      const record = await room.record(code);
      if (!record?.state) break;
      if (record.state.phase === 'gameOver') break;

      for (const seat of seats) {
        const sync = await room.read(code, seat.token, 0);
        const state = (await room.record(code))!.state!;

        // 1. Nothing in the room payload is a card this viewer may not see.
        const hidden = hiddenCardIds(state, seat.id);
        const leaked = [...visibleCardIds(sync.room)].filter((id) => hidden.has(id));
        expect(leaked, `${seat.id} could see cards ${leaked.join(', ')}`).toEqual([]);

        // 2. Every event handed over was addressed to this player. A private
        //    event is the ONE place a face is allowed to travel, so the routing
        //    is the safety property — not the contents.
        for (const event of sync.events) expect(event.to).toBe(seat.id);
      }

      // Advance the game so the next pass sees a different state.
      const turnId = record.state.players[record.state.turnSeat]!.id;
      const actor = seats.find((s) => s.id === turnId)!;
      const view = await room.read(code, actor.token);
      if (view.room.status !== 'playing') break;
      if (view.room.view.phase === 'peek') {
        room.advance(60_000);
        continue;
      }
      const move = turnMove(view.room.view, actor.id);
      if (move) await room.act(code, actor.token, move);
      else room.advance(120_000);
    }
  });

  it('hands a peek only to the player who earned it', async () => {
    const room = makeTestRoom(5);
    const { code, seats } = await room.deal(['Ana', 'Bo']);
    const [ana, bo] = seats;

    const peeked = await room.act(code, ana!.token, { type: 'PEEK', playerId: ana!.id, slot: 2 });
    expect(peeked.refusal).toBeUndefined();
    expect(peeked.events).toHaveLength(1);
    expect(peeked.events[0]!.to).toBe('p1');
    expect(peeked.events[0]!.card).toBeDefined();

    // Bo is handed nothing, and can see nothing extra.
    const boSync = await room.read(code, bo!.token, 0);
    expect(boSync.events).toEqual([]);

    const hidden = hiddenCardIds((await room.record(code))!.state!, bo!.id);
    const leaked = [...visibleCardIds(boSync.room)].filter((id) => hidden.has(id));
    expect(leaked).toEqual([]);
  });

  it('still delivers a peek whose push never arrived', async () => {
    const room = makeTestRoom(5);
    const { code, seats } = await room.deal(['Ana', 'Bo']);
    const ana = seats[0]!;

    const before = (await room.read(code, ana.token, 0)).eventSeq;
    const peeked = await room.act(code, ana.token, { type: 'PEEK', playerId: ana.id, slot: 2 });
    const card = peeked.events[0]!.card;

    // A client that missed the push asks from its old cursor and still gets the
    // card. This is the whole reason the queue exists.
    const replay = await room.read(code, ana.token, before);
    expect(replay.events.map((e) => e.card)).toEqual([card]);

    // Having collected it, asking from the new cursor returns nothing.
    const drained = await room.read(code, ana.token, replay.eventSeq);
    expect(drained.events).toEqual([]);
  });
});

describe('the clock only moves when somebody touches the room', () => {
  it('resolves a peek deadline on the next read, with no timer anywhere', async () => {
    const room = makeTestRoom();
    const { code, seats } = await room.deal(['Ana', 'Bo']);
    expect((await room.record(code))!.state!.phase).toBe('peek');

    const deadline = (await room.record(code))!.state!.peekDeadline;
    room.advance(deadline - room.now() + 1);

    const sync = await room.read(code, seats[0]!.token);
    if (sync.room.status !== 'playing') throw new Error('expected a game');
    expect(sync.room.view.phase).toBe('turnStart');
  });

  it('does not write when a read has nothing to do', async () => {
    const room = makeTestRoom();
    const { code, seats } = await room.deal(['Ana', 'Bo']);
    const first = await room.read(code, seats[0]!.token);
    const revBefore = (await room.record(code))!.rev;

    const second = await room.read(code, seats[0]!.token, first.eventSeq);
    expect((await room.record(code))!.rev).toBe(revBefore);
    expect(second.eventSeq).toBe(first.eventSeq);
  });
});

describe('leaving', () => {
  it('frees the seat before the deal, and the next arrival takes it back', async () => {
    const room = makeTestRoom();
    const { code } = await room.create('Ana');
    const bo = await room.join(code, 'Bo');
    await room.leave(code, bo.token);
    expect((await room.record(code))!.roster.map((r) => r.name)).toEqual(['Ana']);

    const again = await room.join(code, 'Bo');
    expect(again.id).toBe('p2');
  });

  it('keeps the seat after the deal, and only marks the player gone', async () => {
    const room = makeTestRoom();
    const { code, seats } = await room.deal(['Ana', 'Bo']);
    await room.leave(code, seats[1]!.token);

    const record = await room.record(code);
    // The turn ring is fixed: dropping a player must not renumber everybody.
    expect(record!.roster).toHaveLength(2);
    expect(record!.state!.players.find((p) => p.id === 'p2')!.connected).toBe(false);
  });

  it('hands the host over when the host leaves the lobby', async () => {
    const room = makeTestRoom();
    const { code, seat } = await room.create('Ana');
    await room.join(code, 'Bo');
    await room.leave(code, seat.token);

    const record = await room.record(code);
    expect(record!.hostId).toBe('p2');
    expect(record!.roster.map((r) => r.name)).toEqual(['Bo']);
  });
});

describe('input is not trusted', () => {
  it('rejects an empty name and an oversized one, keeping only 12 characters', async () => {
    const room = makeTestRoom();
    await expect(room.create('   ')).rejects.toThrow(/E_BAD_REQUEST/);
    await expect(room.create(42 as never)).rejects.toThrow(/E_BAD_REQUEST/);

    const { code } = await room.create('  Ana With A Very Long Name  ');
    const record = await room.record(code);
    expect(record!.roster[0]!.name).toBe('Ana With A V');
    expect(record!.roster[0]!.name).toHaveLength(12);
  });

  it('refuses an action while the room is still a lobby', async () => {
    const room = makeTestRoom();
    const { code, seat } = await room.create('Ana');
    await room.join(code, 'Bo');
    await expect(
      room.act(code, seat.token, { type: 'DRAW', playerId: 'p1', from: 'deck' }),
    ).rejects.toThrow(/E_BAD_REQUEST/);
  });
});
