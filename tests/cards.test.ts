import { describe, expect, it } from 'vitest';
import {
  CARDS,
  DECK_SIZE,
  JOKER_IDS,
  SET_SIZE,
  card,
  handTotal,
  isRedKingValue,
  makeDeck,
  matchesForTap,
  rankValue,
  setIndexOf,
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

describe('two decks', () => {
  it('deals 104 cards for two decks, and every id is distinct', () => {
    const one = makeDeck({ jokers: false, decks: 1 });
    const two = makeDeck({ jokers: false, decks: 2 });
    expect(one).toHaveLength(52);
    expect(two).toHaveLength(104);
    // Not two copies of the SAME ids: a physical card has one name even when its
    // twin has the same face, or the "every id is in exactly one zone" accounting
    // that the whole engine leans on would count one card twice.
    expect(new Set(two).size).toBe(104);
  });

  it('carries the jokers into the second set too', () => {
    const two = makeDeck({ jokers: true, decks: 2 });
    expect(two).toHaveLength(108);
    expect(new Set(two).size).toBe(108);
    // Both joker ids from set one, and both from set two.
    for (const id of JOKER_IDS) {
      expect(two).toContain(id);
      expect(two).toContain(id + SET_SIZE);
    }
  });

  it('treats anything that is not an explicit 2 as ONE deck', () => {
    // A state stored before `decks` existed, or a malformed value from a request
    // body, must still deal a normal game rather than an empty or doubled one.
    expect(makeDeck({ jokers: false })).toHaveLength(52);
    expect(makeDeck({ jokers: false, decks: undefined })).toHaveLength(52);
  });

  it('gives both copies of a card the SAME face and artwork', () => {
    // The art has one picture per card, so `setIndexOf` is the id the image is
    // looked up by. If it were wrong, the second deck's seven of hearts would
    // render as a different card — or as nothing.
    const first = card(cid('7', 'H'));
    const second = card(cid('7', 'H') + SET_SIZE);
    expect(setIndexOf(second.id)).toBe(setIndexOf(first.id));
    expect(second.rank).toBe(first.rank);
    expect(second.suit).toBe(first.suit);
    expect(second.red).toBe(first.red);
    expect(second.value).toBe(first.value);
    // ...but they are still two different physical cards.
    expect(second.id).not.toBe(first.id);
  });

  it('lets a tap match the other deck’s copy of the same rank', () => {
    const rules = { redKingsMatchRank: true };
    const top = card(cid('9', 'H'));
    const twin = card(cid('9', 'H') + SET_SIZE);
    // Two decks means every rank exists twice, so this is the common case, not a
    // curiosity: matching is by rank, so either copy answers the pile.
    expect(matchesForTap(twin, top, rules)).toBe(true);
    expect(matchesForTap(card(cid('9', 'S')), top, rules)).toBe(true);
    expect(matchesForTap(card(cid('8', 'H')), top, rules)).toBe(false);
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
