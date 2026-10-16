import type { Card, CardId, PublicCard, Rank, RuleConfig, Suit } from './types';

/**
 * Canonical card table. Ids are stable and contiguous:
 *   0–12   spades   A…K
 *   13–25  hearts   A…K   (red)
 *   26–38  diamonds A…K   (red)
 *   39–51  clubs    A…K
 *   52–53  jokers         (only dealt when `rules.jokers` is on)
 *   54–107  a SECOND deck, the same 54 cards again with every id shifted by 54
 *           (only dealt when `rules.decks` is 2)
 *
 * `CARDS` is the first set and what most callers want; `card(id)` also knows the
 * second. Ids stay contiguous inside a set and unique across both, because the
 * accounting everywhere ("every id is in exactly one zone") needs a physical card
 * to have one name even when its twin has the same face.
 *
 * The table is a module constant rather than part of `GameState`: it never
 * changes, so storing it per-room would only bloat Redis.
 */
export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'] as const;
export const RANKS: readonly Rank[] = [
  'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K',
] as const;

export const DECK_SIZE = 52;
export const JOKER_IDS: readonly CardId[] = [52, 53];
/** Ids per physical set: 52 standard cards plus 2 jokers. A second deck starts here. */
export const SET_SIZE = DECK_SIZE + JOKER_IDS.length;
export const MAX_DECKS = 2;

const RED_SUITS: ReadonlySet<Suit> = new Set<Suit>(['H', 'D']);

export function rankValue(rank: Rank, red: boolean): number {
  switch (rank) {
    case 'A':
      return 1;
    case 'J':
    case 'Q':
      return 10;
    // Both red kings are worth -1; black kings are worth the usual 10.
    case 'K':
      return red ? -1 : 10;
    case 'JOKER':
      return 0;
    default:
      return Number(rank);
  }
}

function buildTable(): Card[] {
  const cards: Card[] = [];
  for (let s = 0; s < SUITS.length; s++) {
    const suit = SUITS[s]!;
    const red = RED_SUITS.has(suit);
    for (let r = 0; r < RANKS.length; r++) {
      const rank = RANKS[r]!;
      cards.push({ id: s * RANKS.length + r, suit, rank, red, value: rankValue(rank, red) });
    }
  }
  for (const id of JOKER_IDS) {
    cards.push({ id, suit: null, rank: 'JOKER', red: false, value: 0 });
  }
  return cards;
}

/** The immutable table, indexed by card id. */
export const CARDS: readonly Card[] = buildTable();

export const MAX_CARD_ID = CARDS.length - 1;

/** Every card of every deck, indexed by id: the first set, then its copy shifted by `SET_SIZE`. */
const ALL_CARDS: readonly Card[] = (() => {
  const out: Card[] = [];
  for (let d = 0; d < MAX_DECKS; d++) {
    for (const c of CARDS) out.push(d === 0 ? c : { ...c, id: c.id + d * SET_SIZE });
  }
  return out;
})();

/**
 * Which of a set's 54 cards this is, ignoring which deck it came from.
 *
 * The artwork has one picture per card, so a second deck's seven of hearts is
 * drawn exactly like the first's. This is the id the art is looked up by.
 */
export function setIndexOf(id: CardId): number {
  return id % SET_SIZE;
}

/**
 * Look up a card. Throws on an unknown id — that is an engine bug, never a user
 * error, so it must not be swallowed into an `EngineError`.
 */
export function card(id: CardId): Card {
  const c = ALL_CARDS[id];
  if (!c) throw new Error(`kaboo: unknown card id ${id}`);
  return c;
}

export function toPublicCard(c: Card): PublicCard {
  return { id: c.id, rank: c.rank, suit: c.suit, red: c.red, value: c.value };
}

export function publicCard(id: CardId): PublicCard {
  return toPublicCard(card(id));
}

/** The unshuffled deck for the given rules, top-of-pile first. */
export function makeDeck(rules: Pick<RuleConfig, 'jokers'> & Partial<Pick<RuleConfig, 'decks'>>): CardId[] {
  const ids: CardId[] = [];
  // Anything but an explicit 2 is one deck, so a state stored before `decks`
  // existed (or a malformed value) still deals a normal game.
  const decks = rules.decks === 2 ? 2 : 1;
  for (let d = 0; d < decks; d++) {
    const base = d * SET_SIZE;
    for (let id = 0; id < DECK_SIZE; id++) ids.push(base + id);
    if (rules.jokers) for (const joker of JOKER_IDS) ids.push(base + joker);
  }
  return ids;
}

/**
 * Fisher–Yates, driven by an injected uniform [0, 1) generator.
 *
 * Never replace this with `sort(() => Math.random() - 0.5)`: that shuffle is
 * measurably biased and, worse, cannot be seeded, which would make the engine
 * untestable.
 */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** A red king — the only card that scores negative, and the one card excluded from pairs. */
export function isRedKingValue(c: Card): boolean {
  return c.rank === 'K' && c.red;
}

/** Sum of the card values in a hand. Empty slots contribute nothing. */
export function handTotal(hand: readonly (CardId | null)[], rules: Pick<RuleConfig, 'mattsPairs'>): number {
  let total = 0;
  const seen = new Map<string, CardId>();
  const pairedIds = new Set<CardId>();

  for (const id of hand) {
    if (id === null) continue;
    const c = card(id);
    total += c.value;

    if (!rules.mattsPairs || c.suit === null) continue;
    // "Matt's pairs": a matching pair in a hand counts 0 — red kings excepted.
    if (isRedKingValue(c)) continue;
    const key = c.rank;
    const prev = seen.get(key);
    if (prev !== undefined) {
      pairedIds.add(prev);
      pairedIds.add(id);
    } else {
      seen.set(key, id);
    }
  }

  for (const id of pairedIds) total -= card(id).value;
  return total;
}

export function occupiedCount(hand: readonly (CardId | null)[]): number {
  let n = 0;
  for (const id of hand) if (id !== null) n++;
  return n;
}

export function isEmptyHand(hand: readonly (CardId | null)[]): boolean {
  return occupiedCount(hand) === 0;
}

/** Effect ranks, or `null` when the card has no effect on discard. */
export function effectFor(c: Card): 'ownPeek' | 'otherPeek' | 'blindSwap' | 'queenSwap' | 'kingPeek' | null {
  switch (c.rank) {
    case '7':
    case '8':
      return 'ownPeek';
    case '9':
    case '10':
      return 'otherPeek';
    case 'J':
      return 'blindSwap';
    case 'Q':
      return 'queenSwap';
    case 'K':
      return 'kingPeek';
    default:
      return null;
  }
}

/**
 * Does `candidate` match the top discard for tapping purposes?
 *
 * Matching is by RANK, so any king matches any king (including red ones) when
 * `rules.redKingsMatchRank` is on. Jokers only ever match jokers.
 */
export function matchesForTap(candidate: Card, top: Card, rules: Pick<RuleConfig, 'redKingsMatchRank'>): boolean {
  if (candidate.rank === 'JOKER' || top.rank === 'JOKER') {
    return candidate.rank === top.rank;
  }
  if (candidate.rank !== top.rank) return false;
  if (candidate.rank === 'K' && !rules.redKingsMatchRank) {
    // Fall back to colour-exact matching when the rule is off.
    return candidate.red === top.red;
  }
  return true;
}

/** Every card id in a state, exactly once — used by tests to assert conservation. */
export function allCardIdsInPlay(
  deck: readonly CardId[],
  discard: readonly CardId[],
  hands: readonly (readonly (CardId | null)[])[],
  extra: readonly (CardId | null)[],
): CardId[] {
  const out: CardId[] = [...deck, ...discard];
  for (const hand of hands) for (const id of hand) if (id !== null) out.push(id);
  for (const id of extra) if (id !== null) out.push(id);
  return out;
}
