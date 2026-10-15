import { beforeEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '../src/engine/types';
import { arrange, arrangeShortDeck, cid, createTable, finishPeek, handOf } from './helpers';
import type { Table } from './helpers';

function privateTo(events: EngineEvent[], playerId: string): EngineEvent[] {
  return events.filter((e) => e.to === playerId);
}

describe('tap race', () => {
  let t: Table;
  beforeEach(() => {
    t = createTable({ players: 3 });
    finishPeek(t);
    arrange(t, {
      hands: {
        p1: [cid('7', 'H'), cid('2', 'S'), cid('3', 'S'), cid('4', 'S')],
        p3: [cid('7', 'D'), cid('5', 'S'), cid('6', 'S'), cid('8', 'S')],
      },
      discard: [cid('7', 'C')],
    });
  });

  it('lets any player tap out of turn, when a table card matches the top discard', () => {
    expect(t.state.players[t.state.turnSeat]!.id).toBe('p2');
    const result = t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    expect(t.state.tap!.playerId).toBe('p1');
    expect(result.events.some((e) => e.type === 'tapClaimed')).toBe(true);
  });

  it('gives the race to whoever commits first and tells the loser "too late"', () => {
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    const loser = t.fail({ type: 'TAP', playerId: 'p3', seenSeq: t.state.discardSeq });
    expect(loser.error!.code).toBe('E_TOO_LATE');
    expect(t.state.tap!.playerId).toBe('p1');
  });

  it('produces the same single winner regardless of which order the two taps arrive', () => {
    // Simulate the two orderings a real race can produce after the store's CAS
    // has serialised them: only the first claimant ever holds the tap.
    const first = createTable({ players: 3 });
    finishPeek(first);
    arrange(first, {
      hands: { p1: [cid('7', 'H'), cid('2', 'S'), cid('3', 'S'), cid('4', 'S')] },
      discard: [cid('7', 'C')],
    });
    first.ok({ type: 'TAP', playerId: 'p1', seenSeq: first.state.discardSeq });
    first.fail({ type: 'TAP', playerId: 'p3', seenSeq: first.state.discardSeq });

    const second = createTable({ players: 3 });
    finishPeek(second);
    arrange(second, {
      hands: { p3: [cid('7', 'D'), cid('5', 'S'), cid('6', 'S'), cid('8', 'S')] },
      discard: [cid('7', 'C')],
    });
    second.ok({ type: 'TAP', playerId: 'p3', seenSeq: second.state.discardSeq });
    second.fail({ type: 'TAP', playerId: 'p1', seenSeq: second.state.discardSeq });

    expect(first.state.tap!.playerId).toBe('p1');
    expect(second.state.tap!.playerId).toBe('p3');
    // Exactly one claimant each time — never two.
    expect(first.state.tap!.playerId).not.toBe('p3');
    expect(second.state.tap!.playerId).not.toBe('p1');
  });

  it('refuses a tap when no table card matches — that is a wrong tap, not an error', () => {
    arrange(t, { hands: { p1: [cid('A', 'H'), cid('2', 'S'), cid('3', 'S'), cid('4', 'S')] } });
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    const result = t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });
    expect(result.error).toBeUndefined();
    expect(result.events.some((e) => e.type === 'tapWrong')).toBe(true);
  });

  it('refuses a tap on a stale view of the discard', () => {
    const stale = t.state.discardSeq;
    arrange(t, { discard: [cid('9', 'C')] });
    const result = t.fail({ type: 'TAP', playerId: 'p1', seenSeq: stale });
    expect(result.error!.code).toBe('E_STALE');
  });

  it('refuses tapping when the discard pile is empty', () => {
    arrange(t, { discard: [] });
    t.fail({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
  });

  it('moves the tapped card to the discard and empties its slot', () => {
    arrange(t, { hands: { p3: [cid('7', 'D'), cid('5', 'S'), cid('6', 'S'), cid('8', 'S')] } });
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p3', slot: 0 } });
    expect(handOf(t, 'p3')[0]).toBeNull();
    expect(t.state.discard[t.state.discard.length - 1]).toBe(cid('7', 'D'));
  });

  it("lets the tapper drop one of their own cards into the hole they made", () => {
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p3', slot: 0 } });
    expect(t.state.tap!.awaitingPlacement).toBe(true);

    t.ok({ type: 'TAP_PLACE', playerId: 'p1', slot: 2 });
    expect(handOf(t, 'p3')[0]).toBe(cid('3', 'S')); // p1's card now fills p3's slot
    expect(handOf(t, 'p1')[2]).toBeNull(); // and p1 no longer holds it
    expect(t.state.tap).toBeNull();
  });

  it('lets the tapper decline to place', () => {
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p3', slot: 0 } });
    t.ok({ type: 'TAP_DECLINE_PLACE', playerId: 'p1' });
    expect(handOf(t, 'p3')[0]).toBeNull();
    expect(handOf(t, 'p1')[2]).toBe(cid('3', 'S'));
    expect(t.state.tap).toBeNull();
  });

  it('does not offer placement when you tapped your own card', () => {
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });
    expect(t.state.tap).toBeNull();
    t.fail({ type: 'TAP_PLACE', playerId: 'p1', slot: 1 });
  });

  it('blocks turn actions while a tap is claimed', () => {
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.fail({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.fail({ type: 'DRAW', playerId: 'p2', from: 'discard' });
  });

  it('resumes the interrupted turn once the tap resolves', () => {
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });
    expect(t.state.phase).toBe('turnStart');
    expect(t.state.players[t.state.turnSeat]!.id).toBe('p2');
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
  });

  it('stops anyone tapping during the deck-out decision', () => {
    const solo = createTable({ players: 2 });
    finishPeek(solo);
    arrangeShortDeck(solo, {
      hands: {
        p1: [cid('7', 'H'), cid('2', 'S'), cid('3', 'S'), cid('4', 'S')],
        p2: [cid('5', 'H'), cid('6', 'S'), cid('9', 'S'), cid('J', 'S')],
      },
      deck: [cid('A', 'C')],
      discardTop: [cid('7', 'C')],
    });
    // p2 draws the last card -> finalSwap
    solo.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    expect(solo.state.phase).toBe('finalSwap');
    expect(solo.state.deck).toHaveLength(0);
    solo.fail({ type: 'TAP', playerId: 'p1', seenSeq: solo.state.discardSeq });
  });
});

describe('wrong-tap penalty', () => {
  let t: Table;
  beforeEach(() => {
    t = createTable({ players: 2 });
    finishPeek(t);
    arrange(t, {
      hands: { p1: [cid('A', 'H'), cid('2', 'S'), cid('3', 'S'), cid('4', 'S')] },
      deck: [cid('9', 'D'), cid('10', 'D'), cid('J', 'D')],
      discard: [cid('7', 'C')],
    });
  });

  it('draws a blind penalty card into the tapper hand, growing it past four', () => {
    const before = handOf(t, 'p1').length;
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });
    expect(handOf(t, 'p1')).toHaveLength(before + 1);
    expect(handOf(t, 'p1')[before]).toBe(cid('9', 'D'));
  });

  it('leaves the named card exactly where it was', () => {
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });
    expect(handOf(t, 'p1')[0]).toBe(cid('A', 'H'));
  });

  it('never hands the penalty card to anyone but the tapper', () => {
    const p2Before = handOf(t, 'p2').length;
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });
    expect(handOf(t, 'p2')).toHaveLength(p2Before);
  });

  it('does not tell the tapper what the penalty card is', () => {
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    const result = t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });
    expect(privateTo(result.events, 'p1').filter((e) => e.type === 'peeked')).toHaveLength(0);
    expect(result.events.every((e) => e.card === undefined)).toBe(true);
  });

  it('frees the tap so somebody else may try', () => {
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });
    expect(t.state.tap).toBeNull();
    expect(t.ok({ type: 'TAP', playerId: 'p2', seenSeq: t.state.discardSeq }).error).toBeUndefined();
  });

  it('charges a penalty card when a claimed tap times out', () => {
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    const before = handOf(t, 'p1').length;
    t.advance(t.rules.tapDeadlineMs + 1);
    const result = t.send({ type: 'READY', playerId: 'p1' }); // any request drives the clock
    expect(result.versionChanged).toBe(true);
    expect(t.state.tap).toBeNull();
    expect(handOf(t, 'p1')).toHaveLength(before + 1);
  });

  it('cancels a timed-out tap without a penalty when the rule is off', () => {
    const lenient = createTable({ players: 2, rules: { tapTimeoutIsWrongTap: false } });
    finishPeek(lenient);
    arrange(lenient, { discard: [cid('7', 'C')], deck: [cid('9', 'D'), cid('10', 'D')] });
    lenient.ok({ type: 'TAP', playerId: 'p1', seenSeq: lenient.state.discardSeq });
    const before = handOf(lenient, 'p1').length;
    lenient.advance(lenient.rules.tapDeadlineMs + 1);
    lenient.send({ type: 'READY', playerId: 'p1' });
    expect(lenient.state.tap).toBeNull();
    expect(handOf(lenient, 'p1')).toHaveLength(before);
  });
});
