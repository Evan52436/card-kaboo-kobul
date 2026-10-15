import type { Action, PlayerId } from '../src/engine/types';
import type { Projection } from '../src/engine/project';

/**
 * ============================================================================
 *  A CLIENT'S DECISION FUNCTION, shared by every test that plays a game
 * ============================================================================
 *  Extracted so `client-contract.test.ts` and `transport-game.test.ts` drive
 *  their games through ONE definition of "what a client would do next". Two
 *  copies would drift, and the drift would be invisible: both suites would go on
 *  passing while testing slightly different players.
 *
 *  The rule this file exists to enforce: **nothing here may read `GameState`.**
 *  Every argument is a `Projection` — the same bytes a phone receives — so if a
 *  move can be chosen here, the real UI can choose it too. A projection that is
 *  safe but incomplete shows up as a `null` return and a stalled game, which is
 *  exactly the failure a human would otherwise find by clicking a dead button.
 * ============================================================================
 */

/** Pick the occupied slots of a player, from the projection alone. */
export function slotsOf(view: Projection, id: PlayerId): number[] {
  return (view.players.find((p) => p.id === id)?.hand ?? [])
    .filter((s) => s.occupied)
    .map((s) => s.index);
}

export function ids(view: Projection): PlayerId[] {
  return view.players.map((p) => p.id);
}

/**
 * One legal move for `playerId`, derived only from what that player can see.
 * Returns null when the projection offers them nothing to do.
 */
export function chooseMove(view: Projection, playerId: PlayerId): Action | null {
  const legal = new Set(view.legalActions);
  const mine = slotsOf(view, playerId);
  const others = ids(view).filter((id) => id !== playerId);

  // --- peek ---------------------------------------------------------------
  if (view.phase === 'peek') {
    // `peekableSlots` is the whole reason this is possible: the UI cannot derive
    // "the bottom two, once each" from `phase`, and must not try. See AGENTS.md §7.
    const slot = view.peekableSlots[0];
    if (legal.has('PEEK') && slot !== undefined) return { type: 'PEEK', playerId, slot };
    if (legal.has('READY')) return { type: 'READY', playerId };
    return null;
  }

  // --- an in-flight tap I own ---------------------------------------------
  if (view.tap && view.tap.playerId === playerId) {
    if (view.tap.awaitingPlacement) {
      const own = mine[0];
      if (own !== undefined) return { type: 'TAP_PLACE', playerId, slot: own };
      return { type: 'TAP_DECLINE_PLACE', playerId };
    }
    // Name a card. The UI can see everyone's slot layout and the public discard.
    for (const id of ids(view)) {
      const slot = slotsOf(view, id)[0];
      if (slot !== undefined) return { type: 'TAP_CHOOSE', playerId, target: { playerId: id, slot } };
    }
    return null;
  }

  // --- deck-out -----------------------------------------------------------
  if (view.phase === 'finalSwap') {
    const own = mine[0];
    if (legal.has('FINAL_SWAP') && own !== undefined) {
      return { type: 'FINAL_SWAP', playerId, slot: own };
    }
    return { type: 'FINAL_DECLINE', playerId };
  }

  // --- effects ------------------------------------------------------------
  if (view.phase === 'effect' && view.effect?.by === playerId) {
    if (view.effect.awaitingKingDecision) return { type: 'EFFECT_KING_DECIDE', playerId, swap: false };
    switch (view.effect.rank) {
      case '7':
      case '8': {
        const slot = mine[0];
        if (slot !== undefined) return { type: 'EFFECT_PEEK_OWN', playerId, slot };
        break;
      }
      case '9':
      case '10': {
        const other = others[0];
        const slot = other === undefined ? undefined : slotsOf(view, other)[0];
        if (other !== undefined && slot !== undefined) {
          return { type: 'EFFECT_PEEK_OTHER', playerId, targetPlayerId: other, slot };
        }
        break;
      }
      case 'J': {
        const a = { playerId, slot: mine[0] ?? -1 };
        const b = {
          playerId: others[0] ?? playerId,
          slot: others[0] ? (slotsOf(view, others[0]!)[0] ?? -1) : -1,
        };
        if (a.slot >= 0 && b.slot >= 0) return { type: 'EFFECT_BLIND_SWAP', playerId, a, b };
        break;
      }
      case 'Q': {
        const slot = mine[0];
        const other = others[0];
        const target = other === undefined ? undefined : slotsOf(view, other)[0];
        if (slot !== undefined && other !== undefined && target !== undefined) {
          return { type: 'EFFECT_QUEEN_SWAP', playerId, slot, target: { playerId: other, slot: target } };
        }
        break;
      }
      case 'K': {
        const a = { playerId, slot: mine[0] ?? -1 };
        const other = others[0];
        const b = {
          playerId: other ?? playerId,
          slot: other ? (slotsOf(view, other)[0] ?? -1) : -1,
        };
        if (a.slot >= 0 && b.slot >= 0) return { type: 'EFFECT_KING_PEEK', playerId, a, b };
        break;
      }
      default:
        break;
    }
    return { type: 'EFFECT_SKIP', playerId };
  }

  // --- the turn spine ------------------------------------------------------
  const isMine = view.turnPlayerId === playerId;

  // A tap is available to ANYONE whenever the discard has a match, so a client
  // must be able to claim one without being the turn player. That is the whole
  // point of the race, and `canTap` + `discardSeq` are what make it expressible.
  if (view.canTap && !view.tap && legal.has('TAP')) {
    return { type: 'TAP', playerId, seenSeq: view.discardSeq };
  }

  if (isMine) {
    if (legal.has('DRAW')) {
      return { type: 'DRAW', playerId, from: view.discardTop ? 'discard' : 'deck' };
    }
    if (legal.has('SWAP')) {
      const slot = mine[0];
      if (slot !== undefined) return { type: 'SWAP', playerId, slot };
    }
    if (legal.has('DISCARD')) return { type: 'DISCARD', playerId };
  }

  if (view.phase === 'reveal' || view.phase === 'gameOver') {
    if (legal.has('CONTINUE')) return { type: 'CONTINUE', playerId };
  }

  return null;
}
