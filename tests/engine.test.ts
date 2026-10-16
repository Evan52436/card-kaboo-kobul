import { beforeEach, describe, expect, it } from 'vitest';
import { occupiedCount } from '../src/engine/cards';
import type { EngineEvent } from '../src/engine/types';
import { arrange, cardLabel, cid, createTable, finishPeek, handOf, seatTurnId } from './helpers';
import type { Table } from './helpers';

/** Events that were delivered privately to a specific player. */
function privateTo(events: EngineEvent[], playerId: string): EngineEvent[] {
  return events.filter((e) => e.to === playerId);
}

function publicEvents(events: EngineEvent[]): EngineEvent[] {
  return events.filter((e) => e.to === undefined);
}

describe('round setup', () => {
  it('deals four cards to each player in fixed 2x2 slots', () => {
    const t = createTable({ players: 2 });
    for (const id of t.ids) {
      expect(handOf(t, id)).toHaveLength(4);
      expect(handOf(t, id).every((c) => c !== null)).toBe(true);
    }
  });

  it('leaves the rest of the deck in the draw pile and starts the discard empty', () => {
    const t = createTable({ players: 2 });
    expect(t.state.deck).toHaveLength(52 - 8);
    expect(t.state.discard).toHaveLength(0);
    expect(t.state.discardSeq).toBe(0);
  });

  it('opens in the peek phase with the turn going to the seat after the dealer', () => {
    const t = createTable({ players: 4 });
    expect(t.state.phase).toBe('peek');
    expect(t.state.dealerSeat).toBe(0);
    expect(t.state.turnSeat).toBe(1);
  });

  it('deals no duplicate cards', () => {
    const t = createTable({ players: 8 });
    const all = [...t.state.deck, ...t.ids.flatMap((id) => handOf(t, id))].filter(
      (x): x is number => x !== null,
    );
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(0);
  });
});

describe('peek phase', () => {
  let t: Table;
  beforeEach(() => {
    t = createTable({ players: 2 });
  });

  it('delivers the peeked card only to the player who peeked', () => {
    const result = t.ok({ type: 'PEEK', playerId: 'p1', slot: 2 });
    const mine = privateTo(result.events, 'p1');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.type).toBe('peeked');
    expect(mine[0]!.slot).toBe(2);
    expect(mine[0]!.card).toBeTruthy();
    // p2 must not receive p1's peek.
    expect(privateTo(result.events, 'p2')).toHaveLength(0);
  });

  it('reveals the card that is actually in the slot', () => {
    arrange(t, { hands: { p1: [cid('A', 'S'), cid('2', 'S'), cid('7', 'H'), cid('K', 'D')] } });
    const result = t.ok({ type: 'PEEK', playerId: 'p1', slot: 2 });
    expect((result.events[0]!.card as { rank: string }).rank).toBe('7');
  });

  it('allows each bottom slot exactly once', () => {
    t.ok({ type: 'PEEK', playerId: 'p1', slot: 2 });
    t.fail({ type: 'PEEK', playerId: 'p1', slot: 2 });
    t.ok({ type: 'PEEK', playerId: 'p1', slot: 3 });
    t.fail({ type: 'PEEK', playerId: 'p1', slot: 3 });
  });

  it('refuses the top row — only the bottom two may be peeked', () => {
    t.fail({ type: 'PEEK', playerId: 'p1', slot: 0 });
    t.fail({ type: 'PEEK', playerId: 'p1', slot: 1 });
  });

  it('refuses actions from a player who is already ready', () => {
    t.ok({ type: 'READY', playerId: 'p1' });
    t.fail({ type: 'PEEK', playerId: 'p1', slot: 2 });
  });

  it('begins turns once every player is ready', () => {
    t.ok({ type: 'READY', playerId: 'p1' });
    expect(t.state.phase).toBe('peek');
    t.ok({ type: 'READY', playerId: 'p2' });
    expect(t.state.phase).toBe('turnStart');
  });

  it('auto-readies everyone when the peek deadline passes with nobody ready', () => {
    t.advance(t.rules.peekDeadlineMs + 1);
    const ticked = t.send({ type: 'READY', playerId: 'p1' });
    expect(ticked.versionChanged).toBe(true);
    expect(t.state.phase).toBe('turnStart');
  });

  it('does not let a player ready another player', () => {
    t.ok({ type: 'READY', playerId: 'p1' });
    expect(t.state.players.find((p) => p.id === 'p2')!.ready).toBe(false);
  });
});

describe('turn flow', () => {
  let t: Table;
  beforeEach(() => {
    t = createTable({ players: 2 });
    finishPeek(t);
  });

  it('gives the first turn to the player after the dealer', () => {
    expect(t.state.phase).toBe('turnStart');
    expect(seatTurnId(t)).toBe('p2');
  });

  it('refuses turn actions from the player whose turn it is not', () => {
    const result = t.fail({ type: 'DRAW', playerId: 'p1', from: 'deck' });
    expect(result.error!.code).toBe('E_NOT_YOUR_TURN');
  });

  it('refuses taking from an empty discard pile', () => {
    t.fail({ type: 'DRAW', playerId: 'p2', from: 'discard' });
  });

  it('draws from the deck and shows the drawn card only to the drawer', () => {
    const next = t.state.deck[0]!;
    const result = t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    expect(t.state.phase).toBe('drawn');
    expect(t.state.drawn!.cardId).toBe(next);
    expect(privateTo(result.events, 'p2').some((e) => e.type === 'drew' && e.card)).toBe(true);
    // The public event must carry no card.
    const pub = publicEvents(result.events).find((e) => e.type === 'drew');
    expect(pub).toBeTruthy();
    expect(pub!.card).toBeUndefined();
  });

  it('swaps the drawn card into a slot and pushes the replaced card to the discard', () => {
    arrange(t, {
      hands: { p2: [cid('A', 'S'), cid('2', 'S'), cid('K', 'D'), cid('5', 'C')] },
      deck: [cid('9', 'H')],
      discard: [],
    });
    const replaced = handOf(t, 'p2')[1];
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.ok({ type: 'SWAP', playerId: 'p2', slot: 1 });
    expect(handOf(t, 'p2')[1]).toBe(cid('9', 'H'));
    expect(t.state.discard[t.state.discard.length - 1]).toBe(replaced);
    expect(t.state.drawn).toBeNull();
  });

  it('discards the drawn card and passes the turn', () => {
    arrange(t, { deck: [cid('4', 'H')] });
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p2' });
    expect(t.state.discard[t.state.discard.length - 1]).toBe(cid('4', 'H'));
    expect(seatTurnId(t)).toBe('p1');
    expect(t.state.phase).toBe('turnStart');
  });

  it('takes the top of the discard and forces a swap', () => {
    arrange(t, { discard: [cid('3', 'S'), cid('8', 'D')] });
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'discard' });
    expect(t.state.drawn!.from).toBe('discard');
    expect(t.state.drawn!.cardId).toBe(cid('8', 'D'));
    expect(t.state.discard).toHaveLength(1);
    // A card taken from the discard cannot simply be discarded back.
    t.ok({ type: 'DISCARD', playerId: 'p2' });
    expect(t.state.discard[t.state.discard.length - 1]).toBe(cid('8', 'D'));
  });

  it('closes the tap window when someone takes from the discard', () => {
    arrange(t, { discard: [cid('3', 'S')] });
    const before = t.state.discardSeq;
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'discard' });
    expect(t.state.discardSeq).toBeGreaterThan(before);
  });

  it('refuses swap and discard when nothing has been drawn', () => {
    t.fail({ type: 'SWAP', playerId: 'p2', slot: 0 });
    t.fail({ type: 'DISCARD', playerId: 'p2' });
  });

  it('refuses an out-of-range slot', () => {
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.fail({ type: 'SWAP', playerId: 'p2', slot: 4 });
    t.fail({ type: 'SWAP', playerId: 'p2', slot: -1 });
  });

  it('lets a player swap into an empty slot without discarding anything', () => {
    arrange(t, { hands: { p2: [null, null, null, null] }, deck: [cid('6', 'H')], discard: [] });
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.ok({ type: 'SWAP', playerId: 'p2', slot: 2 });
    expect(handOf(t, 'p2')[2]).toBe(cid('6', 'H'));
    expect(t.state.discard).toHaveLength(0);
  });

  it('plays a safe default when a player runs out of time', () => {
    arrange(t, { deck: [cid('4', 'H')] });
    t.advance(t.rules.turnDeadlineMs + 1);
    const result = t.send({ type: 'DISCARD', playerId: 'p2' });
    expect(result.versionChanged).toBe(true);
    // Auto-play drew AND discarded, so the turn has moved on.
    expect(seatTurnId(t)).toBe('p1');
    expect(t.state.discard[t.state.discard.length - 1]).toBe(cid('4', 'H'));
  });

  it('never auto-calls KABOO on a timed-out player', () => {
    t.advance(t.rules.turnDeadlineMs + 1);
    t.send({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    expect(t.state.kabooCallerId).toBeNull();
    expect(t.state.players.every((p) => !p.calledKaboo)).toBe(true);
  });
});

describe('effects', () => {
  let t: Table;
  beforeEach(() => {
    t = createTable({ players: 2 });
    finishPeek(t);
  });

  /** Draw a specific card and discard it, landing in the effect phase. */
  function discardCard(cardId: number): void {
    arrange(t, { deck: [cardId] });
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.ok({ type: 'DISCARD', playerId: 'p2' });
  }

  it('skips the effect phase entirely for a plain card', () => {
    discardCard(cid('4', 'H'));
    expect(t.state.phase).toBe('turnStart');
    expect(seatTurnId(t)).toBe('p1');
  });

  it('7 and 8 let you look at one of your own cards, privately', () => {
    discardCard(cid('7', 'H'));
    expect(t.state.phase).toBe('effect');
    const result = t.ok({ type: 'EFFECT_PEEK_OWN', playerId: 'p2', slot: 0 });
    const mine = privateTo(result.events, 'p2').filter((e) => e.type === 'peeked');
    expect(mine).toHaveLength(1);
    expect(privateTo(result.events, 'p1').filter((e) => e.type === 'peeked')).toHaveLength(0);
    expect(seatTurnId(t)).toBe('p1');
  });

  it('refuses a 7-effect on an opponent slot', () => {
    discardCard(cid('8', 'H'));
    t.fail({ type: 'EFFECT_PEEK_OTHER', playerId: 'p2', targetPlayerId: 'p1', slot: 0 });
  });

  it('9 and 10 let you look at one opponent card', () => {
    arrange(t, { hands: { p1: [cid('Q', 'S'), cid('2', 'D'), cid('3', 'C'), cid('4', 'S')] } });
    discardCard(cid('9', 'H'));
    const result = t.ok({ type: 'EFFECT_PEEK_OTHER', playerId: 'p2', targetPlayerId: 'p1', slot: 0 });
    const mine = privateTo(result.events, 'p2').filter((e) => e.type === 'peeked');
    expect(mine).toHaveLength(1);
    expect((mine[0]!.card as { rank: string }).rank).toBe('Q');
    // The target learns nothing about their own card from this.
    expect(privateTo(result.events, 'p1').filter((e) => e.type === 'peeked')).toHaveLength(0);
  });

  it('refuses a 9-effect on your own slot', () => {
    discardCard(cid('10', 'H'));
    t.fail({ type: 'EFFECT_PEEK_OTHER', playerId: 'p2', targetPlayerId: 'p2', slot: 0 });
  });

  it('Jack blind-swaps two cards, revealing neither', () => {
    arrange(t, {
      hands: {
        p1: [cid('A', 'S'), cid('2', 'S'), cid('3', 'S'), cid('4', 'S')],
        p2: [cid('K', 'H'), cid('6', 'S'), cid('7', 'S'), cid('8', 'S')],
      },
    });
    discardCard(cid('J', 'H'));
    const result = t.ok({
      type: 'EFFECT_BLIND_SWAP',
      playerId: 'p2',
      a: { playerId: 'p2', slot: 0 },
      b: { playerId: 'p1', slot: 3 },
    });
    expect(handOf(t, 'p2')[0]).toBe(cid('4', 'S'));
    expect(handOf(t, 'p1')[3]).toBe(cid('K', 'H'));
    // Nobody is told a face.
    expect(result.events.filter((e) => e.type === 'peeked')).toHaveLength(0);
  });

  it('refuses a Jack swap of a slot with itself', () => {
    discardCard(cid('J', 'H'));
    t.fail({
      type: 'EFFECT_BLIND_SWAP',
      playerId: 'p2',
      a: { playerId: 'p2', slot: 0 },
      b: { playerId: 'p2', slot: 0 },
    });
  });

  it('refuses a Jack swap into an empty slot', () => {
    arrange(t, { hands: { p1: [cid('A', 'S'), null, null, null] } });
    discardCard(cid('J', 'H'));
    t.fail({
      type: 'EFFECT_BLIND_SWAP',
      playerId: 'p2',
      a: { playerId: 'p2', slot: 0 },
      b: { playerId: 'p1', slot: 1 },
    });
  });

  it('Queen swaps with an opponent and shows NEITHER of them what moved', () => {
    arrange(t, { hands: { p1: [cid('9', 'S'), cid('2', 'D'), cid('3', 'C'), cid('4', 'S')] } });
    const mineBefore = handOf(t, 'p2')[0];
    discardCard(cid('Q', 'H'));
    const result = t.ok({
      type: 'EFFECT_QUEEN_SWAP',
      playerId: 'p2',
      slot: 0,
      target: { playerId: 'p1', slot: 0 },
    });
    // The cards really did move...
    expect(handOf(t, 'p2')[0]).toBe(cid('9', 'S'));
    expect(handOf(t, 'p1')[0]).toBe(mineBefore);

    // ...and nobody was told a face. This is `rules.queenLooks: false`, the
    // default: the owner's call is that a swap between two players is blind for
    // BOTH of them, so the swapper does not get to inspect what they received
    // and the player they took from does not get to see what they were left
    // with. It is the whole point of the effect being a gamble rather than a
    // free improvement. AGENTS.md §6.
    expect(result.events.filter((e) => e.type === 'revealed')).toHaveLength(0);
    // The public event says only WHERE the two cards went, never what they are.
    // (`rank` on it is the rank of the card that was DISCARDED to start the
    // effect — the top of the pile, face-up and public — not of either card that
    // moved, so the assertion is about the `card` field and the two refs.)
    const used = publicEvents(result.events).filter((e) => e.type === 'effectUsed');
    expect(used).toHaveLength(1);
    expect(used[0]).not.toHaveProperty('card');
    expect(result.events.every((e) => !('card' in e))).toBe(true);
    // Both sides of the swap are told where it happened, and nothing else.
    expect(privateTo(result.events, 'p1').filter((e) => e.type === 'revealed')).toHaveLength(0);
  });

  it('Queen shows the swapper what they received when `queenLooks` is on', () => {
    // The non-default reading from the original gist, kept covered so the flag
    // stays honest in both positions (AGENTS.md §6, §9 "legalActions is honest"
    // in spirit: a flag with a branch behind it needs a test on each side).
    const q = createTable({ players: 2, rules: { queenLooks: true } });
    finishPeek(q);
    arrange(q, {
      hands: { p1: [cid('9', 'S'), cid('2', 'D'), cid('3', 'C'), cid('4', 'S')] },
      deck: [cid('Q', 'H')],
    });
    q.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    q.ok({ type: 'DISCARD', playerId: 'p2' });

    const result = q.ok({
      type: 'EFFECT_QUEEN_SWAP',
      playerId: 'p2',
      slot: 0,
      target: { playerId: 'p1', slot: 0 },
    });
    const revealed = privateTo(result.events, 'p2').filter((e) => e.type === 'revealed');
    expect(revealed).toHaveLength(1);
    expect((revealed[0]!.card as { rank: string }).rank).toBe('9');
    // Still only the swapper. The player they took from learns nothing either way.
    expect(privateTo(result.events, 'p1').filter((e) => e.type === 'revealed')).toHaveLength(0);
  });

  it('refuses a Queen swap with yourself', () => {
    discardCard(cid('Q', 'H'));
    t.fail({
      type: 'EFFECT_QUEEN_SWAP',
      playerId: 'p2',
      slot: 0,
      target: { playerId: 'p2', slot: 1 },
    });
  });

  it('King peeks two cards, then decides — and only the decider sees the faces', () => {
    arrange(t, {
      hands: {
        p1: [cid('A', 'S'), cid('2', 'D'), cid('3', 'C'), cid('4', 'S')],
        p2: [cid('K', 'S'), cid('6', 'S'), cid('7', 'S'), cid('8', 'S')],
      },
    });
    discardCard(cid('K', 'H'));
    const peekResult = t.ok({
      type: 'EFFECT_KING_PEEK',
      playerId: 'p2',
      a: { playerId: 'p2', slot: 0 },
      b: { playerId: 'p1', slot: 0 },
    });
    expect(privateTo(peekResult.events, 'p2').filter((e) => e.type === 'peeked')).toHaveLength(2);
    expect(privateTo(peekResult.events, 'p1').filter((e) => e.type === 'peeked')).toHaveLength(0);
    expect(t.state.effect!.awaitingKingDecision).toBe(true);
    expect(t.state.phase).toBe('effect');

    t.ok({ type: 'EFFECT_KING_DECIDE', playerId: 'p2', swap: true });
    expect(handOf(t, 'p2')[0]).toBe(cid('A', 'S'));
    expect(handOf(t, 'p1')[0]).toBe(cid('K', 'S'));
    expect(seatTurnId(t)).toBe('p1');
  });

  it('King can decline the swap after looking', () => {
    arrange(t, { hands: { p2: [cid('K', 'S'), cid('6', 'S'), cid('7', 'S'), cid('8', 'S')] } });
    discardCard(cid('K', 'H'));
    t.ok({
      type: 'EFFECT_KING_PEEK',
      playerId: 'p2',
      a: { playerId: 'p2', slot: 0 },
      b: { playerId: 'p2', slot: 1 },
    });
    t.ok({ type: 'EFFECT_KING_DECIDE', playerId: 'p2', swap: false });
    expect(handOf(t, 'p2')[0]).toBe(cid('K', 'S'));
  });

  it('requires a King decision before the turn can end', () => {
    discardCard(cid('K', 'H'));
    t.ok({
      type: 'EFFECT_KING_PEEK',
      playerId: 'p2',
      a: { playerId: 'p2', slot: 0 },
      b: { playerId: 'p2', slot: 1 },
    });
    t.fail({ type: 'DISCARD', playerId: 'p2' });
    t.fail({ type: 'EFFECT_PEEK_OWN', playerId: 'p2', slot: 0 });
  });

  it('only the triggering player may resolve the effect', () => {
    discardCard(cid('7', 'H'));
    t.fail({ type: 'EFFECT_PEEK_OWN', playerId: 'p1', slot: 0 });
    t.fail({ type: 'EFFECT_SKIP', playerId: 'p1' });
  });

  it('lets a player decline their own effect', () => {
    discardCard(cid('J', 'H'));
    t.ok({ type: 'EFFECT_SKIP', playerId: 'p2' });
    expect(seatTurnId(t)).toBe('p1');
  });

  it('never triggers an effect from a swap', () => {
    arrange(t, { deck: [cid('7', 'H')] });
    t.ok({ type: 'DRAW', playerId: 'p2', from: 'deck' });
    t.ok({ type: 'SWAP', playerId: 'p2', slot: 1 });
    // A 7 was swapped in, not discarded — no effect.
    expect(t.state.phase).toBe('turnStart');
    expect(seatTurnId(t)).toBe('p1');
  });

  it('never triggers an effect from a tap discard', () => {
    // The tapped card is a 7 — a rank that WOULD open an effect phase if it had
    // been discarded during a turn. A tap must not.
    arrange(t, {
      hands: { p1: [cid('7', 'H'), cid('2', 'S'), cid('3', 'S'), cid('4', 'S')] },
      discard: [cid('7', 'C')],
    });
    t.ok({ type: 'TAP', playerId: 'p1', seenSeq: t.state.discardSeq });
    t.ok({ type: 'TAP_CHOOSE', playerId: 'p1', target: { playerId: 'p1', slot: 0 } });

    expect(handOf(t, 'p1')[0]).toBeNull();
    expect(t.state.discard[t.state.discard.length - 1]).toBe(cid('7', 'H'));
    expect(t.state.phase).toBe('turnStart');
    expect(t.state.effect).toBeNull();
  });
});

describe('card labelling (sanity for test diagnostics)', () => {
  it('renders a readable label', () => {
    expect(cardLabel(cid('K', 'H'))).toBe('KH');
    expect(cardLabel(52)).toBe('JOKER');
    expect(cardLabel(null)).toBe('--');
  });

  it('counts occupied slots', () => {
    expect(occupiedCount([1, null, 3, null])).toBe(2);
  });
});
