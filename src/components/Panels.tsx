'use client';

import type { Projection } from '@/engine/project';
import type { PlayerId } from '@/engine/types';
import type { Peek } from '@/lib/useGame';
import { Card } from './Card';

/** The one-line "what is happening / what do I do" pill. */
export function StatusPill({
  view,
  viewerId,
  deadline,
  now,
  canTap,
  onTap,
}: {
  view: Projection;
  viewerId: PlayerId;
  deadline: number;
  now: number;
  canTap: boolean;
  onTap: () => void;
}) {
  const seconds = deadline > now ? Math.ceil((deadline - now) / 1000) : null;

  return (
    <div className="kb-status">
      <span className="kb-chip kb-chip--dark">{describe(view, viewerId, seconds)}</span>
      {canTap && (
        <button type="button" className="kb-btn kb-btn--kaboo" onClick={onTap}>
          Tap the pile
        </button>
      )}
    </div>
  );
}

function describe(view: Projection, viewerId: PlayerId, seconds: number | null): string {
  const name = (id: PlayerId | null) => view.players.find((p) => p.id === id)?.name ?? '?';
  const you = viewerId === view.youId;

  if (view.phase === 'peek') return you ? 'Look at your bottom two' : `${name(viewerId)} is looking`;
  if (view.phase === 'reveal') return 'Reveal';
  if (view.phase === 'gameOver') return 'Game over';

  const turn = you ? 'Your turn' : `${name(view.turnPlayerId)}'s turn`;
  if (view.phase === 'finalSwap') return `${name(view.turnPlayerId)} drew the last card`;
  if (view.tap) {
    const who = view.tap.playerId === viewerId ? 'You' : name(view.tap.playerId);
    return `${who} tapped — pick a matching card`;
  }
  if (view.effect) return `${turn} · effect in play`;
  if (seconds !== null) return `${turn} · ${seconds}s`;
  return turn;
}

/**
 * The left-hand scoreboard: cumulative scores only.
 *
 * The brief is explicit that a player's own live total is never shown, and the
 * projection never computes one — so there is nothing here to accidentally leak.
 */
export function Scoreboard({ view, viewerId }: { view: Projection; viewerId: PlayerId }) {
  return (
    <section className="kb-panel kb-panel--scores" aria-label="Scoreboard">
      <h2 className="kb-panel__title kb-header">Scores</h2>
      <ol className="kb-scores">
        {view.players.map((p) => (
          <li
            key={p.id}
            className={`kb-scores__row${p.isTurn ? ' kb-scores__row--turn' : ''}${
              p.id === viewerId ? ' kb-scores__row--you' : ''
            }`}
          >
            <span className="kb-scores__name">
              {p.name}
              {p.id === viewerId && <span className="kb-chip kb-chip--soft">you</span>}
              {p.calledKaboo && <span className="kb-chip kb-chip--dark">kaboo</span>}
            </span>
            <span className="kb-scores__cards" aria-label={`${p.handCount} cards`}>
              {p.handCount}
            </span>
            <span className="kb-scores__total">{p.score}</span>
          </li>
        ))}
      </ol>
      <p className="kb-panel__note">
        Round {view.round} of {view.rounds} · draw pile {view.drawPileCount}
      </p>
    </section>
  );
}

/**
 * The right-hand log.
 *
 * Every line is `who did what`. The type carries no card face at all, so this
 * panel cannot leak one even by mistake — see the `LogEntry` decision in §7.
 */
export function GameLog({ view }: { view: Projection }) {
  const lines = view.log.slice(-40).reverse();
  return (
    <section className="kb-panel kb-panel--log" aria-label="Game log">
      <h2 className="kb-panel__title kb-header">Log</h2>
      <ol className="kb-log">
        {lines.map((entry, i) => (
          <li key={`${entry.round}:${entry.kind}:${i}`} className="kb-log__row">
            <span className="kb-log__kind">{entry.kind}</span>
            <span className="kb-log__text">
              {[entry.actor, entry.target, entry.text].filter(Boolean).join(' · ')}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Transient notices for cards this viewer was privately told about.
 *
 * These are not state and are not remembered for them: the peek arrived as an
 * event, and once dismissed it is gone. That is the point of the design — a
 * player who does not read their own notice has simply forgotten the card.
 */
export function PeekTray({ peeks, onDismiss }: { peeks: Peek[]; onDismiss: () => void }) {
  if (peeks.length === 0) return null;
  return (
    <aside className="kb-peeks" role="status">
      <div className="kb-peeks__head">
        <span className="kb-chip kb-chip--soft">you saw</span>
        <button type="button" className="kb-btn kb-btn--small" onClick={onDismiss}>
          Remember it
        </button>
      </div>
      <div className="kb-peeks__cards">
        {peeks.map((p) => (
          <figure className="kb-peeks__item" key={p.key}>
            <Card card={p.card} label={p.label} />
            <figcaption className="kb-label">{p.label}</figcaption>
          </figure>
        ))}
      </div>
    </aside>
  );
}
