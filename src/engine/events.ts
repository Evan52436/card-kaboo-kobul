import type { EngineEvent, PlayerId } from './types';

/** Append a PUBLIC event — the transport may broadcast it to every player. */
export function emit(events: EngineEvent[], event: EngineEvent): void {
  events.push(event);
}

/**
 * Append a PRIVATE event — the transport must route it only to `to`'s channel.
 *
 * Peeks and other one-off looks travel this way precisely because they are not
 * stored anywhere: if the event is missed, the information is gone, exactly as
 * it would be at a real table.
 */
export function emitPrivate(events: EngineEvent[], to: PlayerId, event: EngineEvent): void {
  events.push({ ...event, to });
}
