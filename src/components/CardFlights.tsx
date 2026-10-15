'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Projection } from '@/engine/project';
import type { PublicCard } from '@/engine/types';
import { placeKey, planFlights, type Move, type Place } from '@/lib/flights';
import { cardFile } from './Card';

/**
 * ============================================================================
 *  CARD FLIGHTS — the table moving, instead of the table changing
 * ============================================================================
 *  Every new snapshot is compared with the last (`planFlights`), and each card
 *  that moved is drawn as a "ghost" that travels from where it was to where it
 *  is now, while the real card at the destination stays hidden until it lands.
 *  That is the whole trick: the state is already correct the instant it arrives,
 *  and the ghost is only a way of showing the player where it came from.
 *
 *  Nothing here is state. Ghosts live outside React, in `document.body`, so a
 *  re-render mid-flight cannot cancel one, and they never take a click.
 *
 *  Layout is read from `data-flight` anchors (`Hand` for slots, `GameScreen` for
 *  the three piles). They are static positions, so the rectangle of a card's
 *  origin and destination can both be read after the new snapshot is rendered.
 *
 *  Under `prefers-reduced-motion` the ghosts are skipped, but the landing ring is
 *  kept: the movement is decoration, "this is the card that changed" is not.
 * ============================================================================
 */

/** Long enough to follow with the eye, short enough that nobody waits on it. */
const FLIGHT_MS = 420;
/** How long the ring stays on the card that arrived. */
const LANDED_MS = 1200;
const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';

interface Flight {
  cancel: () => void;
  finished: Promise<void>;
}

export function CardFlights({ view }: { view: Projection }) {
  const previous = useRef<Projection | null>(null);
  const inFlight = useRef<Set<() => void>>(new Set());

  // A layout effect, so a destination is hidden before the browser paints it —
  // otherwise the card would flash into place and only then fly there.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = view;
    if (!before || document.visibilityState !== 'visible') return;

    const moves = planFlights(before, view);
    if (moves.length === 0) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const move of moves) {
      const flight = fly(move, reduced);
      if (!flight) continue;
      inFlight.current.add(flight.cancel);
      void flight.finished.then(() => inFlight.current.delete(flight.cancel));
    }
  }, [view]);

  // Leaving the table mid-flight must not leave a card hanging over the page.
  useEffect(() => {
    const active = inFlight.current;
    return () => {
      for (const cancel of active) cancel();
      active.clear();
    };
  }, []);

  return null;
}

function anchorFor(place: Place): HTMLElement | null {
  const key = placeKey(place).replace(/["\\]/g, '\\$&');
  return document.querySelector<HTMLElement>(`[data-flight="${key}"]`);
}

/** The card inside an anchor, or the anchor itself when it is the card. */
const cardIn = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>('.kb-card') ?? el;

function fly(move: Move, reduced: boolean): Flight | null {
  const fromEl = anchorFor(move.from);
  const toEl = anchorFor(move.to);
  if (!fromEl || !toEl) return null;

  // A hand scrolls sideways, so a card can land out of sight. Bring the spot into
  // view first (`nearest`: a no-op when it is already visible), so the journey
  // ends somewhere the player can see.
  if (move.to.zone === 'slot') toEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const target = cardIn(toEl);
  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  if (a.width === 0 || b.width === 0) return null;

  if (reduced) {
    markLanded(target);
    return null;
  }

  const ghost = document.createElement('div');
  ghost.className = 'kb-card kb-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, {
    left: `${a.left}px`,
    top: `${a.top}px`,
    width: `${a.width}px`,
    height: `${a.height}px`,
    transformOrigin: 'top left',
  });

  // One face when the card looks the same at both ends; two, crossfaded at the
  // midpoint, when it turns over on the way (a card you drew goes face-down into
  // your hand; a card from a hand lands face-up on the pile).
  const start = faceLayer(move.startFace);
  ghost.append(start);
  const sameFace = move.startFace?.id === move.endFace?.id;
  let end: HTMLElement | null = null;
  if (!sameFace) {
    end = faceLayer(move.endFace);
    end.style.opacity = '0';
    ghost.append(end);
  }
  document.body.append(ghost);

  const visibility = target.style.visibility;
  target.style.visibility = 'hidden';

  const dx = b.left - a.left;
  const dy = b.top - a.top;
  const scale = b.width / a.width;

  const motion = ghost.animate(
    [
      { transform: 'translate(0px, 0px) scale(1)' },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
    ],
    { duration: FLIGHT_MS, easing: EASE, fill: 'forwards' },
  );
  if (end) {
    const timing: KeyframeAnimationOptions = { duration: FLIGHT_MS, fill: 'forwards' };
    start.animate(
      [{ opacity: 1 }, { opacity: 1, offset: 0.45 }, { opacity: 0, offset: 0.55 }, { opacity: 0 }],
      timing,
    );
    end.animate(
      [{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1, offset: 0.55 }, { opacity: 1 }],
      timing,
    );
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    ghost.remove();
    target.style.visibility = visibility;
  };

  const finished = motion.finished.then(
    () => {
      cleanup();
      markLanded(target);
    },
    () => cleanup(),
  );

  return {
    cancel: () => {
      motion.cancel();
      cleanup();
    },
    finished,
  };
}

/** One face of a ghost: the card's art, or the CSS back when it is face-down. */
function faceLayer(card: PublicCard | null): HTMLElement {
  const layer = document.createElement('div');
  const file = card ? cardFile(card) : null;

  if (file) {
    layer.className = 'kb-ghost__layer';
    const img = document.createElement('img');
    img.className = 'kb-card__face';
    img.src = `/cards/${file}.png`;
    img.alt = '';
    img.draggable = false;
    layer.append(img);
  } else {
    layer.className = 'kb-ghost__layer kb-ghost__layer--back';
    const back = document.createElement('span');
    back.className = 'kb-card__back';
    layer.append(back);
  }
  return layer;
}

/** A ring on the card that just arrived: the answer to "where did it go?" */
function markLanded(el: HTMLElement) {
  el.classList.add('kb-card--landed');
  window.setTimeout(() => el.classList.remove('kb-card--landed'), LANDED_MS);
}
