import type { EngineError } from './types';

/**
 * All rejection messages are deliberately generic and identical in tone.
 *
 * A rejection reason is itself information. "That card doesn't match" would tell
 * the actor what an opponent's face-down card is; even "it isn't your turn" is
 * fine, but nothing that depends on a hidden card may ever be distinguished.
 * When in doubt, return `illegal()`.
 */
const MESSAGES = {
  E_ILLEGAL: "That isn't allowed right now.",
  E_NOT_YOUR_TURN: "It isn't your turn.",
  E_STALE: 'The table moved on. Refresh to catch up.',
  E_TOO_LATE: 'Too late.',
  E_UNKNOWN_PLAYER: 'Unknown player.',
  E_ROOM_FULL: 'That room is full.',
  E_GAME_OVER: 'That game has finished.',
} as const;

export function err(code: EngineError['code']): EngineError {
  return { ok: false, code, message: MESSAGES[code] };
}

/** The catch-all: never say why, when why could leak. */
export function illegal(): EngineError {
  return err('E_ILLEGAL');
}

export function isError(v: unknown): v is EngineError {
  return typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;
}
