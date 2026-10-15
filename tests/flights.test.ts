import { describe, expect, it } from 'vitest';
import { placeKey, planFlights, type FlightView } from '../src/lib/flights';
import type { PublicCard } from '../src/engine/types';

/**
 * `planFlights` decides which cards the table animates. Its rule is "recognise a
 * pattern or draw nothing", so these pin both halves: the patterns it should
 * recognise, and the confusing snapshots it must stay quiet about.
 */

const card = (id: number, rank: string, suit: string | null = 'S') =>
  ({ id, rank, suit }) as unknown as PublicCard;

const SEVEN = card(6, '7');
const KING = card(12, 'K');

function hand(...gens: (number | null)[]) {
  return gens.map((gen, index) => ({ index, occupied: gen !== null, gen: gen ?? 0 }));
}

function view(overrides: Partial<FlightView> = {}): FlightView {
  return {
    round: 1,
    phase: 'turnStart',
    drawPileCount: 40,
    discardCount: 3,
    discardTop: SEVEN,
    drawn: null,
    heldCard: null,
    players: [
      { id: 'p1', hand: hand(0, 0, 0, 0) },
      { id: 'p2', hand: hand(0, 0, 0, 0) },
    ],
    ...overrides,
  };
}

const slot = (playerId: string, n: number) => ({ zone: 'slot' as const, playerId, slot: n });

describe('planFlights', () => {
  it('draws nothing without a previous snapshot', () => {
    expect(planFlights(null, view())).toEqual([]);
  });

  it('draws nothing when nothing changed', () => {
    expect(planFlights(view(), view())).toEqual([]);
  });

  it('flies a card from the draw pile to the drawn spot, face-up only for its owner', () => {
    const before = view();
    const mine = view({
      drawPileCount: 39,
      phase: 'drawn',
      drawn: { from: 'deck', by: 'p1', card: KING },
    });
    expect(planFlights(before, mine)).toEqual([
      { from: { zone: 'draw' }, to: { zone: 'drawn' }, startFace: null, endFace: KING },
    ]);

    const theirs = view({
      drawPileCount: 39,
      phase: 'drawn',
      drawn: { from: 'deck', by: 'p2', card: null },
    });
    expect(planFlights(before, theirs)).toEqual([
      { from: { zone: 'draw' }, to: { zone: 'drawn' }, startFace: null, endFace: null },
    ]);
  });

  it('flies a card taken from the discard pile, which was face-up all along', () => {
    const before = view();
    const after = view({
      discardCount: 2,
      discardTop: KING,
      phase: 'drawn',
      drawn: { from: 'discard', by: 'p1', card: SEVEN },
    });
    expect(planFlights(before, after)).toEqual([
      { from: { zone: 'discard' }, to: { zone: 'drawn' }, startFace: SEVEN, endFace: SEVEN },
    ]);
  });

  it('flies the last card of the pile to the drawn spot', () => {
    const before = view({ drawPileCount: 1 });
    const after = view({ drawPileCount: 0, phase: 'finalSwap', heldCard: { card: KING } });
    expect(planFlights(before, after)).toEqual([
      { from: { zone: 'draw' }, to: { zone: 'drawn' }, startFace: null, endFace: KING },
    ]);
  });

  it('shows a swap as two flights: the drawn card in, the replaced card out', () => {
    const before = view({
      phase: 'drawn',
      drawPileCount: 39,
      drawn: { from: 'deck', by: 'p1', card: KING },
    });
    const after = view({
      drawPileCount: 39,
      discardCount: 4,
      discardTop: SEVEN,
      players: [
        { id: 'p1', hand: hand(0, 0, 1, 0) },
        { id: 'p2', hand: hand(0, 0, 0, 0) },
      ],
    });
    expect(planFlights(before, after)).toEqual([
      { from: { zone: 'drawn' }, to: slot('p1', 2), startFace: KING, endFace: null },
      { from: slot('p1', 2), to: { zone: 'discard' }, startFace: null, endFace: SEVEN },
    ]);
  });

  it('shows a discard as one flight from the drawn spot to the pile', () => {
    const before = view({
      phase: 'drawn',
      drawPileCount: 39,
      drawn: { from: 'deck', by: 'p2', card: null },
    });
    const after = view({ drawPileCount: 39, discardCount: 4, discardTop: KING });
    expect(planFlights(before, after)).toEqual([
      { from: { zone: 'drawn' }, to: { zone: 'discard' }, startFace: null, endFace: KING },
    ]);
  });

  it('shows a Jack, Queen or King swap as two cards trading places', () => {
    const after = view({
      players: [
        { id: 'p1', hand: hand(0, 1, 0, 0) },
        { id: 'p2', hand: hand(0, 0, 2, 0) },
      ],
    });
    expect(planFlights(view(), after)).toEqual([
      { from: slot('p1', 1), to: slot('p2', 2), startFace: null, endFace: null },
      { from: slot('p2', 2), to: slot('p1', 1), startFace: null, endFace: null },
    ]);
  });

  it('shows a successful tap as a card leaving a hand for the pile', () => {
    const after = view({
      discardCount: 4,
      discardTop: card(19, '7', 'H'),
      players: [
        { id: 'p1', hand: hand(0, 0, 0, 0) },
        { id: 'p2', hand: hand(0, null, 0, 0) },
      ],
    });
    expect(planFlights(view(), after)).toEqual([
      { from: slot('p2', 1), to: { zone: 'discard' }, startFace: null, endFace: card(19, '7', 'H') },
    ]);
  });

  it("shows the tapper's own card moving into the spot a tap emptied", () => {
    const before = view({
      players: [
        { id: 'p1', hand: hand(0, 0, 0, 0) },
        { id: 'p2', hand: hand(0, null, 0, 0) },
      ],
    });
    const after = view({
      players: [
        { id: 'p1', hand: hand(0, 0, null, 0) },
        { id: 'p2', hand: hand(0, 1, 0, 0) },
      ],
    });
    expect(planFlights(before, after)).toEqual([
      { from: slot('p1', 2), to: slot('p2', 1), startFace: null, endFace: null },
    ]);
  });

  it('shows a penalty card as the draw pile dealing into a hand', () => {
    const after = view({
      drawPileCount: 39,
      players: [
        { id: 'p1', hand: hand(0, 0, 0, 0, 0) },
        { id: 'p2', hand: hand(0, 0, 0, 0) },
      ],
    });
    expect(planFlights(view(), after)).toEqual([
      { from: { zone: 'draw' }, to: slot('p1', 4), startFace: null, endFace: null },
    ]);
  });

  it('stays quiet on a new round, the opening peek and the reveal', () => {
    const drew = view({
      drawPileCount: 39,
      phase: 'drawn',
      drawn: { from: 'deck', by: 'p1', card: KING },
    });
    expect(planFlights(view({ round: 1 }), { ...drew, round: 2 })).toEqual([]);
    expect(planFlights(view({ phase: 'peek' }), drew)).toEqual([]);
    expect(planFlights(view(), { ...drew, phase: 'reveal' })).toEqual([]);
  });

  it('stays quiet about a gap that swallowed several moves', () => {
    // A draw, a swap and a discard all inside one poll interval: the snapshots
    // alone cannot say what went where, so nothing is drawn rather than a guess.
    const after = view({
      drawPileCount: 38,
      discardCount: 5,
      players: [
        { id: 'p1', hand: hand(1, 0, 0, 0) },
        { id: 'p2', hand: hand(0, 0, 1, 0) },
      ],
    });
    expect(planFlights(view(), after)).toEqual([]);
  });
});

describe('placeKey', () => {
  it('names the three piles and each slot distinctly', () => {
    expect(placeKey({ zone: 'draw' })).toBe('draw');
    expect(placeKey({ zone: 'discard' })).toBe('discard');
    expect(placeKey({ zone: 'drawn' })).toBe('drawn');
    expect(placeKey(slot('p1', 2))).toBe('slot:p1:2');
    expect(placeKey(slot('p1', 2))).not.toBe(placeKey(slot('p2', 2)));
  });
});
