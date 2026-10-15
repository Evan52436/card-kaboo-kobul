import { describe, expect, it } from 'vitest';
import {
  CARDS,
  DECK_SIZE,
  JOKER_IDS,
  handTotal,
  isRedKingValue,
  makeDeck,
  matchesForTap,
  rankValue,
  shuffle,
} from '../src/engine/cards';
import { cid, seededRng } from './helpers';

describe('card values', () => {
  it('scores the documented values', () => {
    expect(rankValue('A', false)).toBe(1);
    expect(rankValue('5', false)).toBe(5);
    expect(rankValue('10', false)).toBe(10);
    expect(rankValue('J', false)).toBe(10);
    expect(rankValue('Q', true)).toBe(10);
    expect(rankValue('K', false)).toBe(10);
    expect(rankValue('JOKER', false)).toBe(0);
  });

  it('makes BOTH red kings worth -1 and black kings worth 10', () => {
    const redKings = CARDS.filter((c) => c.rank === 'K' && c.red);
    const blackKings = CARDS.filter((c) => c.rank === 'K' && !c.red);
    expect(redKings).toHaveLength(2);
    expect(blackKings).toHaveLength(2);
    for (const k of redKings) expect(k.value).toBe(-1);
    for (const k of blackKings) expect(k.value).toBe(10);
  });

  it('has exactly 52 standard cards with unique ids', () => {
    const standard = CARDS.filter((c) => c.rank !== 'JOKER');
    expect(standard).toHaveLength(DECK_SIZE);
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(CARDS.length);
  });

  it('excludes jokers from the deck unless the flag is on', () => {
    expect(makeDeck({ jokers: false })).toHaveLength(52);
    expect(makeDeck({ jokers: false }).some((id) => JOKER_IDS.includes(id))).toBe(false);
    expect(makeDeck({ jokers: true })).toHaveLength(54);
    expect(makeDeck({ jokers: true })).toContain(52);
  });
});

describe('shuffle', () => {
  it('is a permutation — no card is lost or duplicated', () => {
    const input = makeDeck({ jokers: true });
    const out = shuffle(input, seededRng(3));
    expect(out).toHaveLength(input.length);
    expect([...out].sort((a, b) => a - b)).toEqual([...input].sort((a, b) => a - b));
    expect(input).toEqual(makeDeck({ jokers: true })); // input untouched
  });

  it('is reproducible from a seed', () => {
    const a = shuffle(makeDeck({ jokers: false }), seededRng(99));
    const b = shuffle(makeDeck({ jokers: false }), seededRng(99));
    expect(a).toEqual(b);
  });

  it('actually reorders (not an identity function)', () => {
    const input = makeDeck({ jokers: false });
    const out = shuffle(input, seededRng(12345));
    expect(out).not.toEqual(input);
  });

  it('produces a spread of orderings across seeds', () => {
    const firsts = new Set<number>();
    for (let seed = 0; seed < 200; seed++) {
      firsts.add(shuffle(makeDeck({ jokers: false }), seededRng(seed))[0]!);
    }
    // A biased shuffle (or an identity) would collapse this badly.
    expect(firsts.size).toBeGreaterThan(30);
  });
});

describe('handTotal', () => {
  const off = { mattsPairs: false };
  const on = { mattsPairs: true };

  it('sums plain values', () => {
    expect(handTotal([cid('A', 'S'), cid('5', 'H'), null, null], off)).toBe(6);
  });

  it('counts red kings as -1', () => {
    expect(handTotal([cid('K', 'H'), cid('K', 'D')], off)).toBe(-2);
    expect(handTotal([cid('K', 'H'), cid('K', 'S')], off)).toBe(9);
  });

  it('ignores empty slots', () => {
    expect(handTotal([null, null, null, null], off)).toBe(0);
    expect(handTotal([cid('A', 'S'), null], off)).toBe(1);
  });

  it("applies Matt's pairs only when the flag is on", () => {
    expect(handTotal([cid('4', 'S'), cid('4', 'H')], off)).toBe(8);
    expect(handTotal([cid('4', 'S'), cid('4', 'H')], on)).toBe(0);
  });

  it("excludes red kings from Matt's pairs", () => {
    // A pair of red kings is worth -2 and stays -2 even with pairs on.
    expect(handTotal([cid('K', 'H'), cid('K', 'D')], on)).toBe(-2);
    // A red king does not zero out a black king either.
    expect(handTotal([cid('K', 'H'), cid('K', 'S')], on)).toBe(9);
  });

  it('zeroes only the paired cards, not the whole hand', () => {
    expect(handTotal([cid('4', 'S'), cid('4', 'H'), cid('9', 'C'), null], on)).toBe(9);
  });
});

describe('tap matching', () => {
  it('matches on rank', () => {
    expect(matchesForTap(CARDS[cid('7', 'S')]!, CARDS[cid('7', 'H')]!, { redKingsMatchRank: true })).toBe(true);
    expect(matchesForTap(CARDS[cid('7', 'S')]!, CARDS[cid('8', 'H')]!, { redKingsMatchRank: true })).toBe(false);
  });

  it('matches kings regardless of colour by default', () => {
    expect(matchesForTap(CARDS[cid('K', 'H')]!, CARDS[cid('K', 'S')]!, { redKingsMatchRank: true })).toBe(true);
  });

  it('falls back to colour-exact kings when the flag is off', () => {
    expect(matchesForTap(CARDS[cid('K', 'H')]!, CARDS[cid('K', 'S')]!, { redKingsMatchRank: false })).toBe(false);
    expect(matchesForTap(CARDS[cid('K', 'H')]!, CARDS[cid('K', 'D')]!, { redKingsMatchRank: false })).toBe(true);
  });

  it('only matches jokers with jokers', () => {
    expect(matchesForTap(CARDS[52]!, CARDS[53]!, { redKingsMatchRank: true })).toBe(true);
    expect(matchesForTap(CARDS[52]!, CARDS[cid('A', 'S')]!, { redKingsMatchRank: true })).toBe(false);
  });

  it('treats a red king as a king for tapping, even though it scores -1', () => {
    const redKing = CARDS[cid('K', 'H')]!;
    expect(isRedKingValue(redKing)).toBe(true);
    expect(matchesForTap(redKing, CARDS[cid('K', 'C')]!, { redKingsMatchRank: true })).toBe(true);
  });
});
