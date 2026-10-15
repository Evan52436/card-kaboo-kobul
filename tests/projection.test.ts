import { describe, expect, it } from 'vitest';
import { project } from '../src/engine/project';
import type { Projection } from '../src/engine/project';
import { applyAction } from '../src/engine/reduce';
import type { Action, ActionType, GameState, PlayerId } from '../src/engine/types';
import { arrange, arrangeShortDeck, cid, createTable, finishPeek, handOf } from './helpers';
import type { Table } from './helpers';

/**
 * Every card face the projection contains, found by shape.
 *
 * A `PublicCard` is the only object in a projection that carries a numeric `id`
 * together with a `rank`, so this finds exactly the cards a client can see — no
 * matter where in the payload they are hiding.
 */
function visibleCardIds(value: unknown, out = new Set<number>()): Set<number> {
  if (Array.isArray(value)) {
    for (const item of value) visibleCardIds(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.id === 'number' && typeof obj.rank === 'string') out.add(obj.id);
    for (const item of Object.values(obj)) visibleCardIds(item, out);
  }
  return out;
}

/** Card ids this viewer must NOT be able to see. */
function hiddenFrom(state: GameState, viewerId: PlayerId): Set<number> {
  const revealed = state.phase === 'reveal' || state.phase === 'gameOver';
  const hidden = new Set<number>();

  // 1. Everybody's hand — including your own, which you must remember.
  if (!revealed) {
    for (const p of state.players) for (const id of p.hand) if (id !== null) hidden.add(id);
  }
  // 2. The draw pile, always: its order is the whole game's secret.
  for (const id of state.deck) hidden.add(id);
  // 3. The declined last card, until the reveal.
  if (!revealed && state.setAside !== null) hidden.add(state.setAside);
  // 4. The deck-out card in front of somebody else.
  if (state.heldCardId !== null && state.players[state.turnSeat]?.id !== viewerId) {
    hidden.add(state.heldCardId);
  }
  // 5. A card drawn from the DRAW pile, to everyone but the drawer. A card taken
  //    from the discard was already face-up, so it stays public.
  if (state.drawn && state.drawn.by !== viewerId && state.drawn.from === 'deck') {
    hidden.add(state.drawn.cardId);
  }
  return hidden;
}

function expectNoLeak(state: GameState, where: string): void {
  for (const viewer of state.players) {
    const p = project(state, viewer.id);
    const visible = visibleCardIds(p);
    const hidden = hiddenFrom(state, viewer.id);
    const leaked = [...visible].filter((id) => hidden.has(id));
    expect(leaked, `${where}: ${viewer.id} can see hidden card(s) ${leaked.join(', ')}`).toEqual([]);
  }
}

describe('the hidden-information boundary', () => {
  it('never puts a card id on a face-down slot', () => {
    const t = createTable({ players: 3 });
    finishPeek(t);
    const view = t.view('p1');
    for (const player of view.players) {
      for (const slot of player.hand) {
        expect(Object.keys(slot).sort()).toEqual(['face', 'gen', 'index', 'occupied']);
        expect(slot.face).toBeNull();
      }
    }
  });

  it('hides every opponent card during play', () => {
    const t = createTable({ players: 3 });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('A', 'S'), cid('A', 'H'), cid('2', 'S'), cid('3', 'S')],
        p2: [cid('K', 'C'), cid('Q', 'C'), cid('4', 'S'), cid('5', 'S')],
        p3: [cid('6', 'C'), cid('7', 'C'), cid('8', 'C'), cid('9', 'C')],
      },
      discard: [cid('2', 'D')],
    });

    const view = t.view('p1');
    const visible = visibleCardIds(view);
    expect(visible.has(cid('K', 'C'))).toBe(false);
    expect(visible.has(cid('Q', 'C'))).toBe(false);
    expect(visible.has(cid('6', 'C'))).toBe(false);
    expect(visible.has(cid('7', 'C'))).toBe(false);
    expectNoLeak(t.state, 'arranged table');
  });

  it('hides your own hand from you too — you must remember what you peeked at', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    const own = handOf(t, 'p1').filter((id): id is number => id !== null);
    const visible = visibleCardIds(t.view('p1'));
    for (const id of own) expect(visible.has(id)).toBe(false);
  });

  it('never exposes the order of the draw pile', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    const visible = visibleCardIds(t.view('p1'));
    for (const id of t.state.deck) expect(visible.has(id)).toBe(false);
    expect(t.view('p1').drawPileCount).toBeGreaterThan(0);
  });

  it('shows a card drawn from the deck to its drawer and to nobody else', () => {
    const t = createTable({ players: 3 });
    finishPeek(t);
    arrange(t, { deck: [cid('K', 'C'), cid('Q', 'C')] });
    const top = t.state.deck[0]!;
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });

    expect(visibleCardIds(t.view('p2')).has(top)).toBe(true);
    expect(visibleCardIds(t.view('p1')).has(top)).toBe(false);
    expect(visibleCardIds(t.view('p3')).has(top)).toBe(false);
    expectNoLeak(t.state, 'after a deck draw');
  });

  it('shows a card taken from the discard to everyone, because it was already face-up', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrange(t, { discard: [cid('7', 'D'), cid('9', 'C')] });
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'discard' });

    expect(visibleCardIds(t.view('p2')).has(cid('9', 'C'))).toBe(true);
    expect(visibleCardIds(t.view('p1')).has(cid('9', 'C'))).toBe(true);
    expectNoLeak(t.state, 'after taking the discard');
  });

  it('shows the deck-out card only to the player who drew it', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrangeShortDeck(t, {
      hands: {
        p1: [cid('5', 'S'), cid('6', 'D'), cid('8', 'C'), cid('9', 'S')],
        p2: [cid('A', 'S'), cid('2', 'D'), cid('3', 'C'), cid('4', 'S')],
      },
      deck: [cid('K', 'H')],
      discardTop: [cid('7', 'D')],
    });
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });

    expect(t.view('p2').heldCard).toEqual({ isYours: true, card: expect.objectContaining({ rank: 'K' }) });
    expect(t.view('p1').heldCard).toEqual({ isYours: false, card: null });
    expect(visibleCardIds(t.view('p1')).has(cid('K', 'H'))).toBe(false);
    expectNoLeak(t.state, 'during the deck-out decision');
  });

  it('hides the declined last card until the reveal', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrangeShortDeck(t, {
      hands: {
        p1: [cid('5', 'S'), cid('6', 'D'), cid('8', 'C'), cid('9', 'S')],
        p2: [cid('A', 'S'), cid('2', 'D'), cid('3', 'C'), cid('4', 'S')],
      },
      deck: [cid('K', 'H')],
      discardTop: [cid('7', 'D')],
    });
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.ok({ type: 'FINAL_DECLINE', playerId: 'p2' });

    // The reveal is what makes it public.
    expect(t.state.phase).toBe('reveal');
    expect(t.view('p1').setAside).toEqual(expect.objectContaining({ rank: 'K' }));
    expect(t.view('p1').revealed).toBe(true);
  });

  it('hides a penalty card: the tapper is never told what they drew', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrange(t, {
      hands: { p1: [cid('A', 'H'), cid('2', 'S'), cid('3', 'S'), cid('4', 'S')] },
      deck: [cid('K', 'C'), cid('Q', 'C')],
      discard: [cid('7', 'C')],
    });
    const penalty = t.state.deck[0]!;
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });

    expect(visibleCardIds(t.view('p1')).has(penalty)).toBe(false);
    expectNoLeak(t.state, 'after a wrong tap');
  });

  it('reveals every hand, and no draw pile, once the round is over', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('A', 'S'), cid('A', 'H'), cid('2', 'S'), cid('3', 'S')],
        p2: [cid('K', 'C'), cid('Q', 'C'), cid('4', 'S'), cid('5', 'S')],
      },
      deck: [cid('5', 'D')], // a plain card: discarding it ends the turn, no effect
    });
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p1' });
    expect(t.state.phase).toBe('reveal');

    const view = t.view('p1');
    const visible = visibleCardIds(view);
    for (const player of view.players) {
      for (const slot of player.hand) {
        if (slot.occupied) expect(slot.face).not.toBeNull();
      }
    }
    expect(visible.has(cid('K', 'C'))).toBe(true);
    expect(visible.has(cid('Q', 'C'))).toBe(true);
    for (const id of t.state.deck) expect(visible.has(id)).toBe(false);
  });

  it('never computes or ships a hand total before the reveal', () => {
    const t = createTable({ players: 3 });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('A', 'S'), cid('A', 'H'), cid('2', 'S'), cid('3', 'S')],
        p2: [cid('K', 'C'), cid('Q', 'C'), cid('4', 'S'), cid('5', 'S')],
      },
    });
    for (const player of t.state.players) {
      const view = t.view(player.id);
      expect(view.roundResult).toBeNull();
      expect(view.gameResult).toBeNull();
      // The word "total" must not appear anywhere in a live projection, under any
      // key — that is the cheapest possible guard against a future leak.
      expect(JSON.stringify(view)).not.toContain('total');
    }
  });

  it('reports a peek as a private event, never as stored state', () => {
    const t = createTable({ players: 2 });
    const result = t.ok({ type: 'PEEK', playerId: 'p1', slot: 2 });

    const peeked = result.events.filter((e) => e.type === 'peeked');
    expect(peeked).toHaveLength(1);
    expect(peeked[0]!.to).toBe('p1'); // private: only the peeker is told
    const face = peeked[0]!.card;
    expect(face).toBeDefined();

    // Even the peeker's own projection shows no face — they have to remember it.
    const mine = t.view('p1').players.find((p) => p.id === 'p1')!;
    expect(mine.hand[2]!.face).toBeNull();

    // The opponent learns nothing at all.
    expect(visibleCardIds(t.view('p2')).has(face!.id)).toBe(false);

    // The log records that a look HAPPENED, and never what was seen. No log line
    // can carry a face at all — see the note on `LogEntry`.
    for (const entry of t.view('p2').log) {
      expect(Object.keys(entry)).not.toContain('card');
    }
  });

  it('never advertises a peek at a slot the rules do not allow', () => {
    const t = createTable({ players: 2 });
    const view = t.view('p1');
    expect(view.peekableSlots).toEqual([2, 3]); // the near row, once each
    expect(view.legalActions).toContain('PEEK');

    t.ok({ type: 'PEEK', playerId: 'p1', slot: 2 });
    expect(t.view('p1').peekableSlots).toEqual([3]);

    t.ok({ type: 'PEEK', playerId: 'p1', slot: 3 });
    // Both looks are spent, so PEEK must no longer be on offer.
    expect(t.view('p1').peekableSlots).toEqual([]);
    expect(t.view('p1').legalActions).not.toContain('PEEK');
    expect(t.view('p1').legalActions).toContain('READY');

    // And the top row is never peekable in the first place.
    expect(t.view('p1').peekableSlots).not.toContain(0);
    expect(t.view('p1').peekableSlots).not.toContain(1);
    t.fail({ type: 'PEEK', playerId: 'p1', slot: 0 });
  });

  it('keeps the tap target public but the surrounding hands hidden', () => {
    const t = createTable({ players: 3 });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('7', 'H'), cid('2', 'S'), cid('3', 'S'), cid('4', 'S')],
        p3: [cid('7', 'D'), cid('5', 'S'), cid('6', 'S'), cid('8', 'S')],
      },
      discard: [cid('7', 'C')],
    });
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p3', slot: 0 } });

    // p3's tapped 7 is now on the discard, so it is public — as is p1's slot.
    expect(t.view('p2').discardTop).toEqual(expect.objectContaining({ rank: '7', suit: 'D' }));
    expectNoLeak(t.state, 'after a tap');
  });

  it('publishes discardSeq, because a TAP cannot be built without it', () => {
    // A TAP must carry the `seenSeq` it was reacting to, so a client that cannot
    // read the discard's sequence number cannot legitimately tap at all. This is
    // the contract the UI depends on; it is public and leaks nothing.
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrange(t, {
      hands: { p1: [cid('7', 'H'), cid('2', 'S'), cid('3', 'S'), cid('4', 'S')] },
      discard: [cid('7', 'C')],
    });

    const before = t.view('p1').discardSeq;
    expect(typeof before).toBe('number');

    // Build the tap from the projection ALONE — never from the state.
    const view = t.view('p1');
    expect(view.canTap).toBe(true);
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: view.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });

    // The sequence moved, and the projection says so.
    expect(t.view('p1').discardSeq).toBeGreaterThan(before);
  });
});

/**
 * `legalActions` exists so the client never re-implements the phase machine.
 * That only works if it is HONEST: every action it advertises must be accepted.
 */
describe('legalActions is honest', () => {
  function build(type: ActionType, state: GameState, viewerId: PlayerId, peekable: number[]): Action | null {
    const me = state.players.find((p) => p.id === viewerId)!;
    const firstOccupied = (hand: (number | null)[]): number => hand.findIndex((id) => id !== null);
    const occupiedSlots = (hand: (number | null)[]): number[] =>
      hand.map((id, i) => (id === null ? -1 : i)).filter((i) => i >= 0);

    switch (type) {
      case 'PEEK': {
        // A peek is only legal in a slot the projection says is peekable.
        const slot = peekable[0];
        return slot === undefined ? null : { type, playerId: viewerId, slot };
      }
      case 'READY':
      case 'CONTINUE':
      case 'CALL_KABOO':
      case 'COUNTER_KABOO':
      case 'DISCARD':
      case 'EFFECT_SKIP':
      case 'FINAL_DECLINE':
      case 'TAP_DECLINE_PLACE':
        return { type, playerId: viewerId };
      case 'DRAW':
        return { type, playerId: viewerId, from: state.deck.length > 0 ? 'deck' : 'discard' };
      case 'SWAP':
      case 'FINAL_SWAP':
        return { type, playerId: viewerId, slot: 0 };
      case 'TAP':
        return { type, playerId: viewerId, seenSeq: state.discardSeq };
      case 'TAP_CHOOSE': {
        const slot = firstOccupied(me.hand);
        return slot < 0 ? null : { type, playerId: viewerId, target: { playerId: viewerId, slot } };
      }
      case 'TAP_PLACE': {
        const slot = firstOccupied(me.hand);
        return slot < 0 ? null : { type, playerId: viewerId, slot };
      }
      case 'EFFECT_PEEK_OWN': {
        const slot = firstOccupied(me.hand);
        return slot < 0 ? null : { type, playerId: viewerId, slot };
      }
      case 'EFFECT_PEEK_OTHER': {
        for (const other of state.players) {
          if (other.id === viewerId) continue;
          const slot = firstOccupied(other.hand);
          if (slot >= 0) return { type, playerId: viewerId, targetPlayerId: other.id, slot };
        }
        return null;
      }
      case 'EFFECT_BLIND_SWAP':
      case 'EFFECT_KING_PEEK': {
        const mine = occupiedSlots(me.hand);
        for (const other of state.players) {
          if (other.id === viewerId) continue;
          const theirs = occupiedSlots(other.hand);
          if (mine.length > 0 && theirs.length > 0) {
            return {
              type,
              playerId: viewerId,
              a: { playerId: viewerId, slot: mine[0]! },
              b: { playerId: other.id, slot: theirs[0]! },
            };
          }
        }
        const two = occupiedSlots(me.hand);
        if (two.length >= 2) {
          return {
            type,
            playerId: viewerId,
            a: { playerId: viewerId, slot: two[0]! },
            b: { playerId: viewerId, slot: two[1]! },
          };
        }
        return null;
      }
      case 'EFFECT_QUEEN_SWAP': {
        const slot = firstOccupied(me.hand);
        if (slot < 0) return null;
        for (const other of state.players) {
          if (other.id === viewerId) continue;
          const theirSlot = firstOccupied(other.hand);
          if (theirSlot >= 0) return { type, playerId: viewerId, slot, target: { playerId: other.id, slot: theirSlot } };
        }
        return null;
      }
      case 'EFFECT_KING_DECIDE':
        return { type, playerId: viewerId, swap: true };
      default:
        return null;
    }
  }

  /** Advertised actions must be accepted, allowed-unconstructible ones excepted. */
  function assertHonest(t: Table, where: string): void {
    for (const viewer of t.state.players) {
      const view: Projection = t.view(viewer.id);
      for (const type of view.legalActions) {
        const action = build(type, t.state, viewer.id, view.peekableSlots);
        if (!action) continue; // nothing to aim at; not a lie, just untestable here
        // Pure: the result is inspected and thrown away, so the table is intact
        // for the next advertised action.
        const result = applyAction(t.state, action, { now: t.now(), rng: () => 0.5 });
        expect(
          result.error?.code ?? null,
          `${where}: legalActions offered ${type} to ${viewer.id} but the engine refused it`,
        ).toBeNull();
      }
    }
  }

  it('is honest through peek, turn, draw and effect phases', () => {
    const t = createTable({ players: 2 });
    assertHonest(t, 'peek');
    finishPeek(t);
    assertHonest(t, 'turnStart');
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    assertHonest(t, 'drawn');
    t.ok({ type: 'DISCARD', playerId: 'p2' });
    assertHonest(t, 'turnStart again');
  });

  it('is honest in the effect phase', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrange(t, { deck: [cid('7', 'D'), cid('3', 'C')] }); // a 7 to discard
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p2' });
    expect(t.state.phase).toBe('effect');
    assertHonest(t, 'effect');

    // Resolving an effect hands the turn on, and the advertised set must follow.
    t.ok({ type: 'EFFECT_PEEK_OWN', playerId: 'p2', slot: 3 });
    expect(t.state.phase).toBe('turnStart');
    assertHonest(t, 'after an effect resolved');
  });

  it('is honest through a King\'s two-step decision', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrange(t, { deck: [cid('K', 'D'), cid('3', 'C')] }); // a black king to discard
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p2' });
    expect(t.state.phase).toBe('effect');
    t.ok({
      type: 'EFFECT_KING_PEEK',
      playerId: 'p2',
      a: { playerId: 'p1', slot: 0 },
      b: { playerId: 'p2', slot: 0 },
    });
    expect(t.state.effect!.awaitingKingDecision).toBe(true);
    assertHonest(t, 'awaiting the King decision');
  });

  it('is honest while a tap is claimed', () => {
    const t = createTable({ players: 3 });
    finishPeek(t);
    arrange(t, {
      hands: { p3: [cid('7', 'D'), cid('5', 'S'), cid('6', 'S'), cid('8', 'S')] },
      discard: [cid('7', 'C')],
    });
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    assertHonest(t, 'tap claimed');

    // And again once the tap has emptied somebody else's slot.
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p3', slot: 0 } });
    expect(t.state.tap!.awaitingPlacement).toBe(true);
    assertHonest(t, 'tap awaiting placement');
  });

  it('is honest during the deck-out decision', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrangeShortDeck(t, {
      hands: {
        p1: [cid('5', 'S'), cid('6', 'D'), cid('8', 'C'), cid('9', 'S')],
        p2: [cid('A', 'S'), cid('2', 'D'), cid('3', 'C'), cid('4', 'S')],
      },
      deck: [cid('K', 'H')],
      discardTop: [cid('7', 'D')],
    });
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    assertHonest(t, 'finalSwap');
  });
});

/**
 * The reverse direction: a card the viewer IS entitled to see must actually be
 * there. Without this, "leak nothing" could be satisfied by shipping nothing.
 */
describe('the boundary leaks nothing by shipping nothing', () => {
  it('publishes the discard pile face-up', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrange(t, { discard: [cid('7', 'D'), cid('9', 'C')] });
    const view = t.view('p1');
    expect(view.discardTop).toEqual(expect.objectContaining({ rank: '9', suit: 'C' }));
    expect(view.discardRecent.map((c) => c.id)).toContain(cid('7', 'D'));
    expect(view.discardCount).toBe(2);
  });

  it('counts cards in every hand without naming them', () => {
    const t = createTable({ players: 3 });
    finishPeek(t);
    for (const p of t.state.players) {
      const view = t.view('p1').players.find((q) => q.id === p.id)!;
      expect(view.handCount).toBe(4);
      expect(view.hand.filter((s) => s.occupied)).toHaveLength(4);
    }
  });

  it('tells everyone whose turn it is and who called KABOO', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    const view = t.view('p1');
    expect(view.kabooCallerId).toBe('p2');
    expect(view.turnPlayerId).toBe('p1');
    expect(view.players.find((p) => p.id === 'p2')!.calledKaboo).toBe(true);
  });
});
