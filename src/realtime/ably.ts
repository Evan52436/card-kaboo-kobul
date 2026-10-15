import Ably from 'ably';
import { SYNC_EVENT, roomChannel } from '@/protocol';
import type { Realtime } from './types';

/**
 * The Ably Realtime: what makes this work over the internet rather than over
 * one wifi.
 *
 * Two properties matter and both are choices rather than defaults:
 *
 * 1. **One channel per player, not one per room.** A shared table channel would
 *    mean every projection is broadcast to everyone, and the only thing keeping
 *    a hand secret would be client-side filtering — which is not a boundary at
 *    all. Publishing separately costs at most eight messages per move.
 * 2. **Subscribe-only capabilities.** The token a device receives names exactly
 *    one channel and grants exactly `subscribe`. A player who guesses another
 *    player's channel name still cannot attach to it, so secrecy does not rest
 *    on the channel name being hard to guess.
 */
export function createAblyRealtime(apiKey: string): Realtime {
  const rest = new Ably.Rest({ key: apiKey });

  return {
    kind: 'ably',

    async publish(code, messages) {
      // Best-effort by contract: the action is already committed, so a push
      // failure must not surface as a failed move. A dropped message is
      // recovered from the room's event queue on the next poll.
      const results = await Promise.allSettled(
        messages.map(({ playerId, message }) =>
          rest.channels.get(roomChannel(code, playerId)).publish(SYNC_EVENT, message),
        ),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn('kaboo: realtime publish failed', result.reason);
        }
      }
    },

    async tokenFor(code, playerId) {
      return rest.auth.createTokenRequest({
        // The client id is the player id, so Ably itself enforces that one
        // device can only ever be one player.
        clientId: playerId,
        capability: { [roomChannel(code, playerId)]: ['subscribe'] },
        ttl: 60 * 60 * 1000,
      });
    },
  };
}
