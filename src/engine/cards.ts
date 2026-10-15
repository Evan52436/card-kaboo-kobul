import type { Card, CardId, PublicCard, Rank, RuleConfig, Suit } from './types';

/**
 * Canonical card table. Ids are stable and contiguous:
 *   0–12   spades   A…K
 *   13–25  hearts   A…K   (red)
 *   26–38  diamonds A…K   (red)
 *   39–51  clubs    A…K
 *   52–53  jokers         (only dealt when `rules.jokers` is on)
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

/**
 * Look up a card. Throws on an unknown id — that is an engine bug, never a user
 * error, so it must not be swallowed into an `EngineError`.
 */
export function card(id: CardId): Card {
  const c = CARDS[id];
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
export function makeDeck(rules: Pick<RuleConfig, 'jokers'>): CardId[] {
  const ids: CardId[] = [];
  for (let id = 0; id < DECK_SIZE; id++) ids.push(id);
  if (rules.jokers) ids.push(...JOKER_IDS);
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
