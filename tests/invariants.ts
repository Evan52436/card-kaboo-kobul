import { makeDeck } from '../src/engine/cards';
import { project } from '../src/engine/project';
import type { GameState, PlayerId, RuleConfig } from '../src/engine/types';

/**
 * The card ids a game with these rules deals: 52, or 104 with two decks, plus
 * each set's jokers when they are on.
 *
 * Taken from the engine's own `makeDeck`, so it can never disagree with what is
 * actually dealt — the single source of truth for "cards in play".
 *
 * **This is a SET, not a range, and that distinction is load-bearing.** The id
 * table is fixed: 0–51 the first set, 52–53 its jokers, 54–107 the second set.
 * A jokerless two-deck game therefore deals {0…51, 54…105} and nothing in play
 * ever has the id 52, 53, 106 or 107. Checking `0 .. length-1` against that
 * reports four phantom failures on *every* card (ids 52/53 "in no zone", 104/105
 * "not in play") — a wrong invariant that looks exactly like a real card bug.
 *
 * The fixed table is worth this awkwardness: a card id has to mean the same
 * physical card in every game, because `setIndexOf` maps it to artwork. An id
 * space that shifted with the `jokers` flag would draw a different card. Found
 * by adding `decks: 2` to the property fuzz (AGENTS.md §9).
 */
export function deckIds(rules: Pick<RuleConfig, 'jokers'> & Partial<Pick<RuleConfig, 'decks'>>): number[] {
  return makeDeck(rules);
}

/** How many physical cards a game holds: 52, 54, 104 or 108. */
export function cardsInPlay(rules: Pick<RuleConfig, 'jokers'> & Partial<Pick<RuleConfig, 'decks'>>): number {
  return deckIds(rules).length;
}

/**
 * The three invariants the brief singles out, expressed once so every test that
 * needs them asserts exactly the same thing.
 *
 *   1. every card id is in exactly one zone, and none is lost  → accountingErrors
 *   2. no projection lets a viewer see a card they may not see → leakedCardIds
 *   3. every round terminates                                  → driven by the caller
 */

/**
 * Every card face a projection contains, found by shape rather than by key.
 *
 * A `PublicCard` is the only object in a projection carrying a numeric `id`
 * together with a `rank`, so this finds the cards a client can see wherever they
 * are in the payload — including inside the log.
 */
export function visibleCardIds(value: unknown, out = new Set<number>()): Set<number> {
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

/** Card ids this viewer must NOT be able to see, given the state right now. */
export function hiddenCardIds(state: GameState, viewerId: PlayerId): Set<number> {
  const revealed = state.phase === 'reveal' || state.phase === 'gameOver';
  const hidden = new Set<number>();

  // Everybody's hand — including your own, which you have to remember.
  if (!revealed) {
    for (const p of state.players) for (const id of p.hand) if (id !== null) hidden.add(id);
  }
  // The draw pile, always: its order is the secret the whole game rests on.
  for (const id of state.deck) hidden.add(id);
  // The declined last card, until the reveal.
  if (!revealed && state.setAside !== null) hidden.add(state.setAside);
  // The deck-out card, when it is sitting in front of somebody else.
  if (state.heldCardId !== null && state.players[state.turnSeat]?.id !== viewerId) {
    hidden.add(state.heldCardId);
  }
  // A card drawn from the DRAW pile, to everyone but the drawer. A card taken
  // from the discard was already face-up, so it stays public.
  if (state.drawn && state.drawn.by !== viewerId && state.drawn.from === 'deck') {
    hidden.add(state.drawn.cardId);
  }
  return hidden;
}

/** Card ids a viewer can see but must not: the empty array is the invariant. */
export function leakedCardIds(state: GameState, viewerId: PlayerId): number[] {
  const visible = visibleCardIds(project(state, viewerId));
  const hidden = hiddenCardIds(state, viewerId);
  return [...visible].filter((id) => hidden.has(id)).sort((a, b) => a - b);
}

/** Every zone each card id currently occupies. */
export function zonesByCard(state: GameState): Map<number, string[]> {
  const zones = new Map<number, string[]>();
  const add = (id: number | null | undefined, zone: string): void => {
    if (id === null || id === undefined) return;
    const list = zones.get(id);
    if (list) list.push(zone);
    else zones.set(id, [zone]);
  };

  state.deck.forEach((id, i) => add(id, `deck[${i}]`));
  state.discard.forEach((id, i) => add(id, `discard[${i}]`));
  for (const p of state.players) p.hand.forEach((id, i) => add(id, `${p.id}.hand[${i}]`));
  add(state.setAside, 'setAside');
  add(state.heldCardId, 'heldCard');
  add(state.drawn?.cardId, 'drawn');

  return zones;
}

/**
 * Cards that are lost or in two places at once. The empty array is the invariant:
 * every card in play is accounted for exactly once.
 *
 * `expected` defaults to the ids `state.rules` actually deals, so a two-deck
 * game is checked against its own cards rather than a hard-coded 52. It is still
 * accepted as an argument so a test can assert against a DIFFERENT set on
 * purpose (e.g. proving the check would catch a lost card).
 */
export function accountingErrors(state: GameState, expected: readonly number[] = deckIds(state.rules)): string[] {
  const zones = zonesByCard(state);
  const errors: string[] = [];
  const inPlay = new Set(expected);

  for (const id of expected) {
    const where = zones.get(id);
    if (!where) errors.push(`card ${id} is in no zone`);
    else if (where.length > 1) errors.push(`card ${id} is in ${where.length} zones: ${where.join(', ')}`);
  }
  for (const id of zones.keys()) {
    if (!inPlay.has(id)) errors.push(`card ${id} is not in play (deck size ${expected.length})`);
  }
  return errors;
}
