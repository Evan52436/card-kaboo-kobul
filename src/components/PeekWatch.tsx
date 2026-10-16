'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Projection } from '@/engine/project';
import type { CardRef, Look } from '@/engine/types';
import { placeKey } from '@/lib/flights';

/**
 * ============================================================================
 *  PEEK WATCH — seeing that somebody is looking at your card
 * ============================================================================
 *  At a real table you can see which card an opponent lifts, even though you can
 *  never see what it is. The server says exactly that and no more: a `Look` names
 *  the slot, never a face (`engine/types.ts`). This turns each new one into the
 *  table's version of it: the card lifts and tilts, a ring goes round it, an eye
 *  sits on it for a moment, and a line at the top says it in words.
 *
 *  It is red when the card is YOURS. "Someone is looking at my card" is the one
 *  the owner must notice, so it must not look like somebody else's.
 *
 *  Nothing here is state. The marks are put on the DOM and taken off again, like
 *  `CardFlights`, so a re-render cannot cancel one halfway.
 *
 *  What counts as new is a monotonic `seq`, not a position in a list: the first
 *  view this mounts with sets the baseline (a player who joins late, or reloads,
 *  must not replay the game's history), and only a higher `seq` is ever shown.
 *
 *  Your own looks are skipped: you already have the "you saw" notice for those,
 *  and a ring round the card you just chose says nothing you do not know.
 * ============================================================================
 */

/** How long a look stays marked. Long enough to notice from the corner of the eye. */
const WATCH_MS = 1800;
/** How long the words stay up. */
const NOTE_MS = 3200;
/** A burst (a King looks at two) is fine; a pile-up after a long poll gap is not. */
const MAX_AT_ONCE = 4;

const EYE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square" aria-hidden="true">' +
  '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/>' +
  '<circle cx="12" cy="12" r="3.2" fill="currentColor"/>' +
  '</svg>';

export function PeekWatch({ view }: { view: Projection }) {
  /** The newest `seq` already handled, or `null` before the first view. */
  const baseline = useRef<number | null>(null);
  const note = useRef<HTMLParagraphElement>(null);
  const noteTimer = useRef<number | null>(null);
  const cleanups = useRef<Set<() => void>>(new Set());

  useLayoutEffect(() => {
    const newest = view.looks.reduce((max, look) => Math.max(max, look.seq), 0);
    const seen = baseline.current;
    baseline.current = Math.max(seen ?? 0, newest);
    if (seen === null) return;

    const fresh = view.looks
      .filter((look) => look.seq > seen && look.by !== view.youId)
      .slice(-MAX_AT_ONCE);
    if (fresh.length === 0) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const nameOf = (id: string) => view.players.find((p) => p.id === id)?.name ?? '?';

    for (const look of fresh) {
      const end = mark(look, look.playerId === view.youId, reduced);
      if (end) {
        cleanups.current.add(end);
        // Forget it once it has run its course, so the set never outgrows a look.
        window.setTimeout(() => cleanups.current.delete(end), WATCH_MS + 100);
      }
    }

    // One line for the whole burst, about the newest: a King's two cards are one
    // event to a player, and two stacked notes would be a flicker.
    const last = fresh[fresh.length - 1]!;
    const yours = last.playerId === view.youId;
    const whose = yours
      ? 'your'
      : last.playerId === last.by
        ? 'their own'
        : `${nameOf(last.playerId)}'s`;
    const line = note.current;
    if (line) {
      line.textContent = `${nameOf(last.by)} is looking at ${whose} card ${last.slot + 1}`;
      line.dataset.yours = String(yours);
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
      noteTimer.current = window.setTimeout(() => {
        line.textContent = '';
      }, NOTE_MS);
    }
  }, [view]);

  // A King's two cards stay marked for as long as the decision is pending. The
  // one-off mark above would fade while the table is still waiting on them.
  const king = view.effect?.awaitingKingDecision && view.effect.by !== view.youId ? view.effect : null;
  const kingKey = king?.a && king.b ? `${refKey(king.a)}|${refKey(king.b)}` : null;
  useLayoutEffect(() => {
    if (!king?.a || !king.b) return;
    const targets = [king.a, king.b]
      .map((ref) => ({ ref, card: cardAt(ref) }))
      .filter((t): t is { ref: CardRef; card: HTMLElement } => t.card !== null);
    for (const { ref, card } of targets) {
      card.classList.add(ref.playerId === view.youId ? 'kb-card--spied' : 'kb-card--watched');
    }
    return () => {
      for (const { card } of targets) card.classList.remove('kb-card--spied', 'kb-card--watched');
    };
    // `kingKey` stands for the two refs: depending on the objects themselves would
    // re-run on every poll, since each projection arrives as a fresh object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kingKey]);

  // Leaving the table mid-look must not leave marks behind. (The words' own
  // timer is left to fire: it clears a detached element, which is harmless.)
  useEffect(() => {
    const active = cleanups.current;
    return () => {
      for (const end of active) end();
      active.clear();
    };
  }, []);

  return <p ref={note} className="kb-look-note" role="status" aria-live="polite" />;
}

const refKey = (ref: CardRef) => placeKey({ zone: 'slot', playerId: ref.playerId, slot: ref.slot });

/** The slot's cell: where `Hand` anchors it, and where the eye is placed. */
function cellAt(ref: CardRef): HTMLElement | null {
  const key = refKey(ref).replace(/["\\]/g, '\\$&');
  return document.querySelector<HTMLElement>(`[data-flight="${key}"]`);
}

function cardAt(ref: CardRef): HTMLElement | null {
  return cellAt(ref)?.querySelector<HTMLElement>('.kb-card') ?? null;
}

/**
 * Mark one look on the table. Returns what undoes it, or `null` if the card is not
 * on screen (a hand scrolled away, or a layout without that seat).
 */
function mark(look: Look, yours: boolean, reduced: boolean): (() => void) | null {
  const ref: CardRef = { playerId: look.playerId, slot: look.slot };
  const cell = cellAt(ref);
  const card = cell?.querySelector<HTMLElement>('.kb-card') ?? null;
  if (!cell || !card) return null;

  // A hand scrolls sideways, so the card can be out of sight. Bring it into view
  // (`nearest`: nothing moves if it is already visible), or the player would be
  // told about a look they cannot see.
  cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const ring = yours ? 'kb-card--spied' : 'kb-card--watched';
  card.classList.add(ring);

  const eye = document.createElement('span');
  eye.className = yours ? 'kb-eye kb-eye--yours' : 'kb-eye';
  eye.setAttribute('aria-hidden', 'true');
  eye.innerHTML = EYE; // a constant above, never anything the server sent
  cell.append(eye);

  const motions: Animation[] = [];
  if (!reduced) {
    // The card is lifted and tilted, held, then put back down.
    motions.push(
      card.animate(
        [
          { transform: 'translateY(0) rotate(0deg)' },
          { transform: 'translateY(-10px) rotate(-6deg)', offset: 0.18 },
          { transform: 'translateY(-10px) rotate(-6deg)', offset: 0.82 },
          { transform: 'translateY(0) rotate(0deg)' },
        ],
        { duration: WATCH_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
      ),
    );
    // The eye pops in and fades out.
    motions.push(
      eye.animate(
        [
          { opacity: 0, transform: 'scale(0.5)' },
          { opacity: 1, transform: 'scale(1)', offset: 0.12 },
          { opacity: 1, transform: 'scale(1)', offset: 0.8 },
          { opacity: 0, transform: 'scale(1)' },
        ],
        { duration: WATCH_MS, fill: 'forwards' },
      ),
    );
  }

  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    window.clearTimeout(timer);
    for (const motion of motions) motion.cancel();
    card.classList.remove(ring);
    eye.remove();
  };
  const timer = window.setTimeout(end, WATCH_MS);
  return end;
}
