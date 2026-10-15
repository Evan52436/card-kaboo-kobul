import { beforeEach, describe, expect, it } from 'vitest';
import { DECK_SIZE } from '../src/engine/cards';
import { arrange, arrangeShortDeck, cid, createTable, finishPeek, handOf } from './helpers';
import type { Table } from './helpers';
import { accountingErrors } from './invariants';
import type { RuleConfig } from '../src/engine/types';

const FOUR_QUEENS = [cid('Q', 'S'), cid('Q', 'H'), cid('Q', 'D'), cid('Q', 'C')];

describe('KABOO', () => {
  let t: Table;
  beforeEach(() => {
    t = createTable({ players: 2 });
    finishPeek(t);
  });

  it('may only be called at the start of your own turn', () => {
    t.fail({ type: 'CALL_KABOO', playerId: 'p1' }); // not p1's turn
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.fail({ type: 'CALL_KABOO', playerId: 'p2' }); // already drawn
  });

  it('ends the caller turn immediately — the caller does not draw', () => {
    const deckBefore = t.state.deck.length;
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    expect(t.state.deck).toHaveLength(deckBefore);
    expect(t.state.drawn).toBeNull();
  });

  it('gives every other player exactly one final turn, then reveals', () => {
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    expect(t.state.kabooCallerId).toBe('p2');
    expect(t.state.finalTurnsRemaining).toEqual(['p1']);

    t.ok({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p1' });
    expect(t.state.phase).toBe('reveal');
  });

  it('marks the caller as having already had their final turn', () => {
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    expect(t.state.players.find((p) => p.id === 'p2')!.finalTurnDone).toBe(true);
    expect(t.state.players.find((p) => p.id === 'p1')!.finalTurnDone).toBe(false);
  });

  it('cycles every other seat in order, and never returns to the caller', () => {
    const four = createTable({ players: 4 });
    finishPeek(four);
    // A draw pile of low cards, so no discard triggers an effect and the final
    // turns follow each other directly.
    arrange(four, { deck: [cid('2', 'S'), cid('3', 'S'), cid('4', 'S')] });
    four.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    expect([...four.state.finalTurnsRemaining].sort()).toEqual(['p1', 'p3', 'p4']);

    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const turnId = four.state.players[four.state.turnSeat]!.id;
      order.push(turnId);
      expect(turnId).not.toBe('p2');
      four.ok({ type: 'DRAW', playerId: turnId, from: 'deck' });
      four.ok({ type: 'DISCARD', playerId: turnId });
    }
    expect(order).toEqual(['p3', 'p4', 'p1']);
    expect(four.state.phase).toBe('reveal');
  });

  it('refuses a second KABOO call in the same round', () => {
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.fail({ type: 'CALL_KABOO', playerId: 'p1' });
  });

  it('can be countered: the counter skips their turn and is scored as a caller', () => {
    arrange(t, {
      hands: {
        p1: FOUR_QUEENS, // 40 — the counter-caller, and a certain loser
        p2: [cid('A', 'S'), cid('A', 'H'), cid('A', 'D'), cid('A', 'C')], // 4
      },
      deck: [cid('9', 'C')],
    });
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'COUNTER_KABOO', playerId: 'p1' });
    expect(t.state.phase).toBe('reveal'); // skipping consumed p1's final turn
    expect(t.state.players.find((p) => p.id === 'p1')!.counterKaboo).toBe(true);
    // A counter-caller who loses eats the same penalty as a caller who loses.
    expect(t.state.roundResult!.winnerId).toBe('p2');
    expect(t.state.roundResult!.penaltyIds).toEqual(['p1']);
    expect(t.state.roundResult!.awarded.p1).toBe(40 + 20);
  });

  it('refuses a counter when the rule is off', () => {
    const off = createTable({ players: 2, rules: { counterKaboo: false } });
    finishPeek(off);
    off.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    off.fail({ type: 'COUNTER_KABOO', playerId: 'p1' });
  });

  it('refuses a counter before anyone has called', () => {
    t.fail({ type: 'COUNTER_KABOO', playerId: 'p2' });
  });

  it('auto-KABOOs the player who loses their last card', () => {
    arrange(t, {
      hands: {
        p1: [cid('7', 'H'), null, null, null], // one card left, matching the discard
        p2: [cid('5', 'S'), cid('6', 'S'), cid('8', 'S'), cid('9', 'S')],
      },
      discard: [cid('7', 'C')],
    });

    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });

    expect(handOf(t, 'p1').every((c) => c === null)).toBe(true);
    expect(t.state.kabooCallerId).toBe('p1');
    expect(t.state.finalTurnsRemaining).toEqual(['p2']);

    // p2's one final turn ends the round.
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p2' });
    expect(t.state.phase).toBe('reveal');
  });

  it('does not auto-KABOO again once a call is already live', () => {
    arrange(t, {
      hands: {
        p1: [cid('7', 'H'), null, null, null],
        p2: [cid('5', 'S'), cid('6', 'S'), cid('8', 'S'), cid('9', 'S')],
      },
      discard: [cid('7', 'C')],
    });
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });

    // Still p2's call — the final-turn queue was not restarted.
    expect(t.state.kabooCallerId).toBe('p2');
    expect(t.state.finalTurnsRemaining).toEqual(['p1']);
  });
});

describe('scoring', () => {
  it('scores the round winner 0 and everyone else their card values', () => {
    const t = createTable({ players: 3 });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('A', 'S'), cid('A', 'H'), null, null], // 2
        p2: [cid('5', 'S'), cid('6', 'D'), null, null], // 11
        p3: [cid('9', 'C'), cid('9', 'D'), null, null], // 18
      },
      deck: [cid('2', 'C')],
    });
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'COUNTER_KABOO', playerId: 'p3' });
    t.ok({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p1' });

    const result = t.state.roundResult!;
    expect(result.totals).toEqual({ p1: 2, p2: 11, p3: 18 });
    expect(result.winnerId).toBe('p1');
    expect(result.awarded.p1).toBe(0);
  });

  it('penalises a caller who did not win, on top of their hand', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('A', 'S'), cid('A', 'H'), null, null], // 2 — the winner
        p2: [cid('5', 'S'), cid('6', 'D'), null, null], // 11 — called and lost
      },
      deck: [cid('2', 'C')],
    });
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p1' });

    const result = t.state.roundResult!;
    expect(result.winnerId).toBe('p1');
    expect(result.penaltyIds).toEqual(['p2']);
    expect(result.awarded.p1).toBe(0);
    expect(result.awarded.p2).toBe(11 + 20);
  });

  it('charges a flat penalty when the rule says flat', () => {
    const t = createTable({ players: 2, rules: { kabooPenaltyMode: 'flat' } });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('A', 'S'), cid('A', 'H'), null, null],
        p2: [cid('5', 'S'), cid('6', 'D'), null, null],
      },
      deck: [cid('2', 'C')],
    });
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p1' });
    expect(t.state.roundResult!.awarded.p2).toBe(20);
  });

  it('gives a caller who DID win a clean 0, with no penalty', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('5', 'S'), cid('6', 'D'), null, null], // 11
        p2: [cid('A', 'S'), cid('A', 'H'), null, null], // 2 — called and won
      },
      deck: [cid('2', 'C')],
    });
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p1' });

    const result = t.state.roundResult!;
    expect(result.winnerId).toBe('p2');
    expect(result.penaltyIds).toEqual([]);
    expect(result.awarded.p2).toBe(0);
  });

  it('scores both red kings as -1', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('K', 'H'), cid('K', 'D'), null, null], // -2 — the winner
        p2: [cid('A', 'S'), cid('A', 'H'), null, null], // 2
      },
      deck: [cid('2', 'C')],
    });
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p1' });
    expect(t.state.roundResult!.totals.p1).toBe(-2);
    expect(t.state.roundResult!.winnerId).toBe('p1');
  });

  it('breaks a tie in favour of the seat nearest the dealer, walking left', () => {
    const t = createTable({ players: 3 }); // dealer seat 0, so p2 plays first
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('A', 'S'), cid('A', 'H'), null, null], // 2
        p2: [cid('A', 'D'), cid('A', 'C'), null, null], // 2
        p3: [cid('9', 'C'), cid('9', 'D'), null, null], // 18
      },
      deck: [cid('2', 'C')],
    });
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'COUNTER_KABOO', playerId: 'p3' });
    t.ok({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p1' });

    const result = t.state.roundResult!;
    expect(result.totals.p1).toBe(result.totals.p2);
    expect(result.winnerId).toBe('p2'); // seat 1 is immediately left of dealer seat 0
  });

  it('folds the round into the cumulative score and deals the next round', () => {
    const t = createTable({ players: 2, rules: { rounds: 3 } });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('A', 'S'), cid('A', 'H'), null, null],
        p2: [cid('5', 'S'), cid('6', 'D'), null, null],
      },
      deck: [cid('2', 'C')],
    });
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p1' });
    expect(t.state.players.find((p) => p.id === 'p2')!.score).toBe(31);

    t.ok({ type: 'CONTINUE', playerId: 'p1' });
    expect(t.state.round).toBe(2);
    expect(t.state.phase).toBe('peek');
    expect(t.state.players.find((p) => p.id === 'p2')!.score).toBe(31);
  });

  it('ends after the configured number of rounds, ranked by lowest total', () => {
    const t = createTable({ players: 2, rules: { rounds: 1 } });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('A', 'S'), cid('A', 'H'), null, null],
        p2: [cid('5', 'S'), cid('6', 'D'), null, null],
      },
      deck: [cid('2', 'C')],
    });
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p1' });
    t.ok({ type: 'CONTINUE', playerId: 'p1' });

    expect(t.state.phase).toBe('gameOver');
    expect(t.state.gameResult!.winnerId).toBe('p1');
    expect(t.state.gameResult!.reason).toBe('fixedRounds');
  });

  it('supports a score-threshold ending', () => {
    const t = createTable({ players: 2, rules: { endCondition: 'scoreThreshold', scoreLimit: 10 } });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('A', 'S'), cid('A', 'H'), null, null],
        p2: [cid('9', 'S'), cid('9', 'D'), null, null],
      },
      deck: [cid('2', 'C')],
    });
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p1' });
    t.ok({ type: 'CONTINUE', playerId: 'p1' }); // p2 is on 18 + 20 = 38, past the limit

    expect(t.state.phase).toBe('gameOver');
    expect(t.state.gameResult!.reason).toBe('scoreThreshold');
  });

  it('refuses every action once the game is over', () => {
    const t = createTable({ players: 2, rules: { rounds: 1 } });
    finishPeek(t);
    t.ok({ type: 'CALL_KABOO', playerId: 'p2' });
    t.ok({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p1' });
    t.ok({ type: 'CONTINUE', playerId: 'p1' });
    expect(t.state.phase).toBe('gameOver');

    const result = t.fail({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    expect(result.error!.code).toBe('E_GAME_OVER');
  });
});

describe('deck out (house rule)', () => {
  /** A table whose draw pile holds exactly one card: the red king of hearts. */
  function deckOutTable(rules?: Partial<RuleConfig>): Table {
    const t = createTable({ players: 2, rules });
    finishPeek(t);
    arrangeShortDeck(t, {
      hands: {
        p1: [cid('5', 'S'), cid('6', 'D'), cid('8', 'C'), cid('9', 'S')], // 28
        p2: [cid('A', 'S'), cid('2', 'D'), cid('3', 'C'), cid('4', 'S')], // 10
      },
      deck: [cid('K', 'H')],
      discardTop: [cid('7', 'D')],
    });
    return t;
  }

  it('ends the round the moment the last card is drawn', () => {
    const t = deckOutTable();
    expect(t.state.deck).toHaveLength(1);
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    expect(t.state.phase).toBe('finalSwap');
    expect(t.state.heldCardId).toBe(cid('K', 'H'));
    expect(t.state.drawn).toBeNull();
  });

  it('shows the last card only to the player who drew it', () => {
    const t = deckOutTable();
    const result = t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });

    const theirs = result.events.filter((e) => e.to === 'p2' && e.type === 'deckOut');
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.card?.rank).toBe('K');

    const publicCopy = result.events.filter((e) => e.to === undefined && e.type === 'deckOut');
    expect(publicCopy).toHaveLength(1);
    expect(publicCopy[0]!.card).toBeUndefined();
  });

  it('lets the drawer swap the last card into their hand, and scores it', () => {
    const t = deckOutTable();
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.ok({ type: 'FINAL_SWAP', playerId: 'p2', slot: 3 });

    expect(handOf(t, 'p2')[3]).toBe(cid('K', 'H'));
    // The replaced card goes to the discard pile, so no card id disappears.
    expect(t.state.discard[t.state.discard.length - 1]).toBe(cid('4', 'S'));
    expect(t.state.setAside).toBeNull();
    expect(t.state.phase).toBe('reveal');
    // A swapped-in red king counts toward the drawer's score: 1 + 2 + 3 - 1.
    expect(t.state.roundResult!.totals.p2).toBe(5);
  });

  it('sets the last card aside, unscored, when the drawer declines', () => {
    const t = deckOutTable();
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.ok({ type: 'FINAL_DECLINE', playerId: 'p2' });

    expect(t.state.setAside).toBe(cid('K', 'H'));
    expect(handOf(t, 'p2')).toEqual([cid('A', 'S'), cid('2', 'D'), cid('3', 'C'), cid('4', 'S')]);
    expect(t.state.roundResult!.totals.p2).toBe(10); // the set-aside card is not counted
    expect(t.state.phase).toBe('reveal');
  });

  it('auto-declines when the drawer never answers', () => {
    const t = deckOutTable();
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.advance(t.rules.finalSwapDeadlineMs + 1);
    t.send({ type: 'READY', playerId: 'p1' }); // any request drives the clock

    expect(t.state.setAside).toBe(cid('K', 'H'));
    expect(t.state.heldCardId).toBeNull();
    expect(t.state.phase).toBe('reveal');
  });

  it('offers no discard, no effect and no tap during the decision', () => {
    const t = deckOutTable();
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.fail({ type: 'DISCARD', playerId: 'p2' });
    t.fail({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    expect(t.state.phase).toBe('finalSwap');
  });

  it('lets only the drawer decide', () => {
    const t = deckOutTable();
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.fail({ type: 'FINAL_DECLINE', playerId: 'p1' });
    t.fail({ type: 'FINAL_SWAP', playerId: 'p1', slot: 0 });
  });

  it('ends the round with no swap offered when a wrong-tap penalty takes the last card', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrangeShortDeck(t, {
      hands: {
        // Nothing in p1's hand matches the 7 on the discard.
        p1: [cid('A', 'S'), cid('2', 'D'), cid('3', 'C'), cid('4', 'S')],
        p2: [cid('5', 'S'), cid('6', 'D'), cid('8', 'C'), cid('9', 'S')],
      },
      deck: [cid('K', 'H')],
      discardTop: [cid('7', 'D')],
    });

    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });

    const hand = handOf(t, 'p1');
    expect(hand).toHaveLength(5); // the penalty card always lands in the hand
    expect(hand[4]).toBe(cid('K', 'H'));
    expect(t.state.phase).toBe('reveal'); // ...and the round ends, with no swap
    expect(t.state.heldCardId).toBeNull();
    expect(t.state.setAside).toBeNull();
  });

  it('never reshuffles the discard back into the draw pile', () => {
    const t = deckOutTable();
    const discardBefore = t.state.discard.length;
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.ok({ type: 'FINAL_DECLINE', playerId: 'p2' });
    expect(t.state.deck).toHaveLength(0);
    expect(t.state.discard).toHaveLength(discardBefore);
  });

  it("keeps the turn player's drawn card when a wrong-tap penalty ends the round", () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrangeShortDeck(t, {
      hands: {
        p1: [cid('5', 'S'), cid('6', 'D'), cid('8', 'C'), cid('9', 'S')], // nothing matches the 7
        p2: [cid('A', 'S'), cid('2', 'D'), cid('3', 'C'), cid('4', 'S')],
      },
      deck: [cid('K', 'H'), cid('Q', 'H')], // p2 draws the king; the queen is the last card
      discardTop: [cid('7', 'D')],
    });

    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    expect(t.state.deck).toHaveLength(1); // one card left, so not a deck-out yet

    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });

    // The penalty card was the last one, so the round ends with p2 mid-draw.
    expect(t.state.phase).toBe('reveal');
    expect(accountingErrors(t.state, DECK_SIZE)).toEqual([]);
    // p2 was holding that card, so it is in their hand — not silently deleted.
    expect(handOf(t, 'p2')[4]).toBe(cid('K', 'H'));
    expect(t.state.roundResult!.totals.p2).toBe(1 + 2 + 3 + 4 - 1);
  });

  it('keeps a drawn card taken from the discard when the round is cut short', () => {
    const t = createTable({ players: 2 });
    finishPeek(t);
    arrangeShortDeck(t, {
      hands: {
        p1: [cid('5', 'S'), cid('6', 'D'), cid('8', 'C'), cid('9', 'S')],
        p2: [cid('A', 'S'), cid('2', 'D'), cid('3', 'C'), cid('4', 'S')],
      },
      deck: [cid('Q', 'H')], // the last card of the pile
      discardTop: [cid('7', 'D')], // p2 takes this one
    });

    t.ok({ type: 'DRAW', playerId: 'p2', from: 'discard' });
    expect(t.state.drawn!.from).toBe('discard');

    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });

    expect(t.state.phase).toBe('reveal');
    expect(accountingErrors(t.state, DECK_SIZE)).toEqual([]);
    expect(handOf(t, 'p2')[4]).toBe(cid('7', 'D')); // the card p2 was holding
  });
});
