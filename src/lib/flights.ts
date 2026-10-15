import type { PlayerId, PublicCard } from '@/engine/types';

/**
 * ============================================================================
 *  FLIGHTS — which card moved where, between two views of the table
 * ============================================================================
 *  The server sends the table as a series of snapshots, and nothing in a snapshot
 *  says "this card went from here to there". This works that out by comparing two
 *  of them, so the UI can show a card travelling instead of the table silently
 *  rearranging itself.
 *
 *  It deliberately reads only what the viewer is already allowed to see: counts,
 *  the public discard top, a slot's `occupied` flag and its `gen` (bumped whenever
 *  the slot's contents change). A card id for a face-down card never appears here
 *  — see the `gen` decision in AGENTS.md §7 — so animating adds no information.
 *
 *  Pure on purpose: no DOM, no React. The DOM half is `CardFlights.tsx`.
 *
 *  Rule of thumb: recognise a pattern or draw nothing. A snapshot gap can swallow
 *  several moves at once (polling is every couple of seconds), and a wrong
 *  animation is worse than none — it tells the player a card went somewhere it
 *  did not.
 * ============================================================================
 */

/** Somewhere a card can be on the table. */
export type Place =
  | { zone: 'draw' }
  | { zone: 'discard' }
  | { zone: 'drawn' }
  | { zone: 'slot'; playerId: PlayerId; slot: number };

export interface Move {
  from: Place;
  to: Place;
  /** What the card shows as it leaves. `null` is face-down. */
  startFace: PublicCard | null;
  /** What it shows as it lands. When this differs from `startFace` the card flips on the way. */
  endFace: PublicCard | null;
}

/** The slice of a projection this needs, so a test can build one by hand. */
export interface FlightView {
  round: number;
  phase: string;
  drawPileCount: number;
  discardCount: number;
  discardTop: PublicCard | null;
  drawn: { from: 'deck' | 'discard'; by: PlayerId; card: PublicCard | null } | null;
  heldCard: { card: PublicCard | null } | null;
  players: { id: PlayerId; hand: { index: number; occupied: boolean; gen: number }[] }[];
}

/** The `data-flight` value the DOM anchors a place with. One definition, two users. */
export function placeKey(place: Place): string {
  return place.zone === 'slot' ? `slot:${place.playerId}:${place.slot}` : place.zone;
}

interface Change {
  kind: 'replaced' | 'vacated' | 'filled';
  playerId: PlayerId;
  slot: number;
}

function slotChanges(prev: FlightView, next: FlightView): Change[] {
  const out: Change[] = [];
  for (const after of next.players) {
    const before = prev.players.find((p) => p.id === after.id);
    if (!before) continue;
    const length = Math.max(before.hand.length, after.hand.length);
    for (let slot = 0; slot < length; slot++) {
      const was = before.hand[slot];
      const is = after.hand[slot];
      const wasThere = was?.occupied === true;
      const isThere = is?.occupied === true;
      if (was && is && wasThere && isThere && was.gen !== is.gen) {
        out.push({ kind: 'replaced', playerId: after.id, slot });
      } else if (wasThere && !isThere) {
        out.push({ kind: 'vacated', playerId: after.id, slot });
      } else if (!wasThere && isThere) {
        out.push({ kind: 'filled', playerId: after.id, slot });
      }
    }
  }
  return out;
}

const slotAt = (change: Change): Place => ({ zone: 'slot', playerId: change.playerId, slot: change.slot });

export function planFlights(prev: FlightView | null, next: FlightView): Move[] {
  if (!prev) return [];
  // A new round is a new deal, not a move.
  if (prev.round !== next.round) return [];
  // The opening peek moves nothing, and the reveal turns every card over at once.
  if (prev.phase === 'peek' || next.phase === 'reveal' || next.phase === 'gameOver') return [];

  const changes = slotChanges(prev, next);
  const discardUp = next.discardCount > prev.discardCount;
  const discardDown = next.discardCount < prev.discardCount;
  const drawDown = next.drawPileCount < prev.drawPileCount;

  // 1. A card was drawn: it travels to the "drawn card" spot.
  if (!prev.drawn && next.drawn) {
    if (next.drawn.from === 'deck' && drawDown) {
      // Face-down out of the pile; face-up on arrival only for the player who drew it.
      return [{ from: { zone: 'draw' }, to: { zone: 'drawn' }, startFace: null, endFace: next.drawn.card }];
    }
    if (next.drawn.from === 'discard' && discardDown) {
      return [
        { from: { zone: 'discard' }, to: { zone: 'drawn' }, startFace: prev.discardTop, endFace: next.drawn.card },
      ];
    }
    return [];
  }

  // 1b. The last card of the pile (the deck-out rule) is held rather than drawn.
  if (!prev.heldCard && next.heldCard && drawDown) {
    return [{ from: { zone: 'draw' }, to: { zone: 'drawn' }, startFace: null, endFace: next.heldCard.card }];
  }

  // 2. The drawn card was dealt with: swapped into a hand, or discarded.
  if (prev.drawn && !next.drawn) {
    const replaced = changes.filter((c) => c.kind === 'replaced' && c.playerId === prev.drawn?.by);
    if (replaced.length === 1 && changes.length === 1) {
      const where = slotAt(replaced[0]!);
      // Into the hand it goes face-down. If the card was known to this viewer it
      // starts face-up and flips on the way, which is what shows "it is now hidden".
      const moves: Move[] = [{ from: { zone: 'drawn' }, to: where, startFace: prev.drawn.card, endFace: null }];
      // And the card it replaced is turned over onto the pile for everyone.
      if (discardUp) moves.push({ from: where, to: { zone: 'discard' }, startFace: null, endFace: next.discardTop });
      return moves;
    }
    if (changes.length === 0 && discardUp) {
      return [{ from: { zone: 'drawn' }, to: { zone: 'discard' }, startFace: prev.drawn.card, endFace: next.discardTop }];
    }
    return [];
  }

  // 3. Nothing was drawn or put down: the table itself rearranged.
  const vacated = changes.filter((c) => c.kind === 'vacated');
  const filled = changes.filter((c) => c.kind === 'filled');
  const replaced = changes.filter((c) => c.kind === 'replaced');

  // A successful tap: a card from a hand goes onto the pile.
  if (vacated.length === 1 && filled.length === 0 && replaced.length === 0 && discardUp) {
    return [{ from: slotAt(vacated[0]!), to: { zone: 'discard' }, startFace: null, endFace: next.discardTop }];
  }

  // The tapper's own card moves into the spot a tap just emptied.
  if (vacated.length === 1 && filled.length === 1 && replaced.length === 0 && !discardUp && !drawDown) {
    return [{ from: slotAt(vacated[0]!), to: slotAt(filled[0]!), startFace: null, endFace: null }];
  }

  // A Jack, Queen or King swap: two cards trade places.
  if (replaced.length === 2 && vacated.length === 0 && filled.length === 0 && !discardUp && !drawDown) {
    const [a, b] = [slotAt(replaced[0]!), slotAt(replaced[1]!)];
    return [
      { from: a, to: b, startFace: null, endFace: null },
      { from: b, to: a, startFace: null, endFace: null },
    ];
  }

  // A penalty card: the pile deals one blind into a hand.
  if (filled.length === 1 && vacated.length === 0 && replaced.length === 0 && drawDown && !discardUp) {
    return [{ from: { zone: 'draw' }, to: slotAt(filled[0]!), startFace: null, endFace: null }];
  }

  return [];
}
