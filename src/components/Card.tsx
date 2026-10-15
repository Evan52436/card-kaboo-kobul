'use client';

import type { PublicCard } from '@/engine/types';

/**
 * A playing card: the real thing, from a public-domain deck.
 *
 * The faces are PNGs under `/public/cards`, rasterised at 3x the widest the UI
 * ever draws a card, so they stay crisp on any phone. The back is ours — drawn
 * in CSS, in the design system's own ink-block language, so a face-down card can
 * never be mistaken for a face-up one at a glance. See AGENTS.md §8 for the
 * provenance and the licence.
 *
 * `gen` is passed as `key` by callers so a slot's contents changing re-mounts the
 * card and replays the reveal. That is why the projection ships `gen` at all — a
 * face-down card cannot ship its id without leaking its face (AGENTS.md §7).
 */
export function Card({
  card,
  faceDown = false,
  selected = false,
  dimmed = false,
  live = false,
  empty = false,
  label,
  onClick,
  disabled = false,
}: {
  card?: PublicCard | null;
  faceDown?: boolean;
  selected?: boolean;
  dimmed?: boolean;
  /**
   * This card is what the current decision is about.
   *
   * A look, not a control state: it makes the card the eye should be on the
   * loudest thing on the table. Only ever set on a card the viewer may act on
   * right now — see how `GameScreen` chooses them.
   */
  live?: boolean;
  empty?: boolean;
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  if (empty) {
    return <div className="kb-card kb-card--empty" aria-hidden="true" />;
  }

  const classes = ['kb-card'];
  if (faceDown) classes.push('kb-card--down');
  if (selected) classes.push('kb-card--selected');
  if (dimmed) classes.push('kb-card--dimmed');
  // Selection wins: the two share the ring, and a card the player has already
  // committed to is answering a different question than "which card is live".
  if (live && !selected) classes.push('kb-card--live');

  const name = faceDown ? 'face-down card' : card ? cardName(card) : 'card';
  const accessible = label ? `${label}: ${name}` : name;

  // Real <button> elements: keyboard, focus ring and hit target come free, and a
  // div with onClick is not a control. AGENTS.md §9.
  if (!onClick) {
    return (
      <div className={classes.join(' ')} role="img" aria-label={accessible}>
        <Face card={card} faceDown={faceDown} />
      </div>
    );
  }

  return (
    <button
      type="button"
      className={classes.join(' ')}
      onClick={onClick}
      disabled={disabled}
      aria-label={accessible}
      aria-pressed={selected}
    >
      <Face card={card} faceDown={faceDown} />
    </button>
  );
}

function Face({ card, faceDown }: { card?: PublicCard | null; faceDown?: boolean }) {
  // The back is CSS, not art: nothing to load, nothing to licence, and it reads
  // as "shut" from across the table.
  if (faceDown || !card) return <span className="kb-card__back" aria-hidden="true" />;

  const file = cardFile(card);
  if (!file) return <span className="kb-card__back" aria-hidden="true" />;

  return (
    // Empty alt: the control around it already carries the card's name, so this
    // is decoration that would otherwise be announced twice.
    //
    // A plain <img>, not next/image: these files are already rendered at exactly
    // the largest size the UI draws a card, so the optimiser has nothing to do
    // but add a round trip and a cache entry per card — while the one thing that
    // matters here is that a card is on screen the instant it is dealt.
    // eslint-disable-next-line @next/next/no-img-element
    <img className="kb-card__face" src={`/cards/${file}.png`} alt="" draggable={false} />
  );
}

/**
 * The artwork's filename for a card: rank then suit, as the deck ships.
 *
 * The two jokers are the engine's ids 52 and 53 in that order; the artwork calls
 * them `Joker1` and `Joker2`, so the id is the only thing that can tell them
 * apart — `suit` is null for both and the ranks are identical.
 */
export function cardFile(card: PublicCard): string | null {
  if (card.rank === 'JOKER') {
    if (card.id === 52) return 'Joker1';
    if (card.id === 53) return 'Joker2';
    return null;
  }
  if (!card.suit) return null;
  return `${card.rank}${card.suit}`;
}

const RANKS: Record<string, string> = {
  A: 'Ace',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
  '10': 'ten',
  J: 'Jack',
  Q: 'Queen',
  K: 'King',
  JOKER: 'Joker',
};

const SUITS: Record<string, string> = {
  S: 'spades',
  H: 'hearts',
  D: 'diamonds',
  C: 'clubs',
};

/**
 * "Queen of hearts", not "QH".
 *
 * A screen reader will not read the art, so this is the whole of what a player
 * relying on one hears about a card — and symbols read out as letters are not a
 * card anybody can hold in their head.
 */
export function cardName(card: PublicCard): string {
  const rank = RANKS[card.rank] ?? card.rank;
  const suit = card.suit ? SUITS[card.suit] : null;
  return suit ? `${rank} of ${suit}` : rank;
}
