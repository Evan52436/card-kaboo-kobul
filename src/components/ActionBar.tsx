'use client';

import type { Projection } from '@/engine/project';

/**
 * Every button here maps to exactly one engine `Action`, and the set of buttons
 * is driven by the projection's own `legalActions` — the engine's honest list of
 * what it will actually accept right now. The UI never re-derives a rule; it
 * renders what it is told is legal. See AGENTS.md §9.
 */
export type Intent =
  | 'none'
  | 'swap'
  | 'finalSwap'
  | 'tapChoose'
  | 'tapPlace'
  | 'effectOwn'
  | 'effectOther'
  | 'blindFirst'
  | 'blindSecond'
  | 'queenOwn'
  | 'queenTarget'
  | 'kingFirst'
  | 'kingSecond';

export interface ActionBarProps {
  view: Projection;
  isYourTurn: boolean;
  can: (action: string) => boolean;
  intent: Intent;
  onIntent: (intent: Intent) => void;
  onDraw: (from: 'deck' | 'discard') => void;
  onDiscard: () => void;
  onKaboo: () => void;
  onCounterKaboo: () => void;
  onReady: () => void;
  onSkipEffect: () => void;
  onKingDecide: (swap: boolean) => void;
  onFinalDecline: () => void;
  onDeclinePlacement: () => void;
  onContinue: () => void;
  waitingOn: string | null;
}

export function ActionBar(props: ActionBarProps) {
  const { view, isYourTurn, can, intent } = props;

  if (view.phase === 'reveal' || view.phase === 'gameOver') {
    return (
      <Bar>
        <button type="button" className="kb-btn kb-btn--primary" onClick={props.onContinue}>
          {view.gameResult ? 'Play again' : 'Next round'}
        </button>
      </Bar>
    );
  }

  if (view.phase === 'peek') {
    return (
      <Bar>
        <Hint>Tap your bottom two cards to look — once each.</Hint>
        <button type="button" className="kb-btn kb-btn--primary" onClick={props.onReady}>
          Ready
        </button>
      </Bar>
    );
  }

  if (view.tap && view.tap.playerId === view.youId) {
    const tap = view.tap;
    return (
      <Bar>
        <Hint>
          {tap.awaitingPlacement
            ? 'Drop one of your cards into the empty spot.'
            : 'Pick the card that matches the top of the pile.'}
        </Hint>
        {tap.awaitingPlacement && (
          <button type="button" className="kb-btn" onClick={props.onDeclinePlacement}>
            Leave it empty
          </button>
        )}
      </Bar>
    );
  }

  if (view.phase === 'finalSwap') {
    return (
      <Bar>
        <Hint>You drew the last card — swap it in, or decline.</Hint>
        <button
          type="button"
          className="kb-btn kb-btn--primary"
          onClick={() => props.onIntent('finalSwap')}
          aria-pressed={intent === 'finalSwap'}
        >
          Swap it in
        </button>
        <button type="button" className="kb-btn" onClick={props.onFinalDecline}>
          Decline
        </button>
      </Bar>
    );
  }

  if (view.phase === 'effect' && view.effect) {
    return <EffectBar {...props} />;
  }

  if (intent === 'swap') {
    return (
      <Bar>
        <Hint>Tap one of your cards to replace it with the one you drew.</Hint>
        <button type="button" className="kb-btn" onClick={() => props.onIntent('none')}>
          Cancel
        </button>
      </Bar>
    );
  }

  // turnStart: nothing drawn yet.
  if (isYourTurn && can('DRAW')) {
    return (
      <Bar>
        <button type="button" className="kb-btn kb-btn--primary" onClick={() => props.onDraw('deck')}>
          Draw
        </button>
        <button
          type="button"
          className="kb-btn"
          onClick={() => props.onDraw('discard')}
          disabled={view.discardTop === null}
        >
          Take the {view.discardTop ? `${view.discardTop.rank}${view.discardTop.suit ?? ''}` : 'pile'}
        </button>
        <button
          type="button"
          className="kb-btn kb-btn--kaboo"
          onClick={props.onKaboo}
          disabled={!can('CALL_KABOO')}
        >
          KABOO
        </button>
        {can('COUNTER_KABOO') && (
          <button type="button" className="kb-btn" onClick={props.onCounterKaboo}>
            Counter-KABOO
          </button>
        )}
      </Bar>
    );
  }

  // drawn: swap or discard.
  if (can('SWAP') || can('DISCARD')) {
    return (
      <Bar>
        <button
          type="button"
          className="kb-btn kb-btn--primary"
          onClick={() => props.onIntent('swap')}
          disabled={!can('SWAP')}
        >
          Swap
        </button>
        <button type="button" className="kb-btn" onClick={props.onDiscard} disabled={!can('DISCARD')}>
          Discard
        </button>
      </Bar>
    );
  }

  return (
    <Bar>
      <Hint>{props.waitingOn ? `Waiting for ${props.waitingOn}.` : 'Nothing to do.'}</Hint>
    </Bar>
  );
}

function EffectBar(props: ActionBarProps) {
  const { view, intent } = props;
  const effect = view.effect;
  if (!effect) return null;
  const rank = effect.rank;
  const mine = effect.by === view.youId;

  if (!mine) {
    return (
      <Bar>
        <Hint>An effect is being played.</Hint>
      </Bar>
    );
  }

  // A King that has already looked at its two cards can only be answered with the
  // swap decision — the engine refuses a skip at that point, and so do we.
  if (effect.awaitingKingDecision) {
    return (
      <Bar>
        <Hint>Swap those two cards?</Hint>
        <button type="button" className="kb-btn kb-btn--primary" onClick={() => props.onKingDecide(true)}>
          Swap them
        </button>
        <button type="button" className="kb-btn" onClick={() => props.onKingDecide(false)}>
          Leave them
        </button>
      </Bar>
    );
  }

  const label = LABELS[rank] ?? 'Use the effect';
  return (
    <Bar>
      <Hint>{label}</Hint>
      {rank === '7' || rank === '8' ? (
        <button
          type="button"
          className="kb-btn kb-btn--primary"
          onClick={() => props.onIntent('effectOwn')}
          aria-pressed={intent === 'effectOwn'}
        >
          Look at my card
        </button>
      ) : null}
      {rank === '9' || rank === '10' ? (
        <button
          type="button"
          className="kb-btn kb-btn--primary"
          onClick={() => props.onIntent('effectOther')}
          aria-pressed={intent === 'effectOther'}
        >
          Look at their card
        </button>
      ) : null}
      {rank === 'J' ? (
        <button
          type="button"
          className="kb-btn kb-btn--primary"
          onClick={() => props.onIntent('blindFirst')}
          aria-pressed={intent === 'blindFirst' || intent === 'blindSecond'}
        >
          Blind-swap two cards
        </button>
      ) : null}
      {rank === 'Q' ? (
        <button
          type="button"
          className="kb-btn kb-btn--primary"
          onClick={() => props.onIntent('queenOwn')}
          aria-pressed={intent === 'queenOwn' || intent === 'queenTarget'}
        >
          Swap one of mine
        </button>
      ) : null}
      {rank === 'K' ? (
        <button
          type="button"
          className="kb-btn kb-btn--primary"
          onClick={() => props.onIntent('kingFirst')}
          aria-pressed={intent === 'kingFirst' || intent === 'kingSecond'}
        >
          Look at two cards
        </button>
      ) : null}
      <button type="button" className="kb-btn" onClick={props.onSkipEffect}>
        Skip
      </button>
    </Bar>
  );
}

const LABELS: Record<string, string> = {
  '7': 'Seven — look at one of your own cards.',
  '8': 'Eight — look at one of your own cards.',
  '9': 'Nine — look at one of another player’s cards.',
  '10': 'Ten — look at one of another player’s cards.',
  J: 'Jack — swap any two cards without looking at either.',
  Q: 'Queen — swap one of yours with any other card; you may look at what you get.',
  K: 'King — look at any two cards, then decide whether to swap them.',
};

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div className="kb-actions" role="toolbar" aria-label="Actions">
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="kb-actions__hint">{children}</p>;
}
