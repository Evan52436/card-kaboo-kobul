import { project } from '../src/engine/project';
import type { GameState, PlayerId } from '../src/engine/types';

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
 */
export function accountingErrors(state: GameState, total: number): string[] {
  const zones = zonesByCard(state);
  const errors: string[] = [];

  for (let id = 0; id < total; id++) {
    const where = zones.get(id);
    if (!where) errors.push(`card ${id} is in no zone`);
    else if (where.length > 1) errors.push(`card ${id} is in ${where.length} zones: ${where.join(', ')}`);
  }
  for (const id of zones.keys()) {
    if (id >= total) errors.push(`card ${id} is not in play (deck size ${total})`);
  }
  return errors;
}
