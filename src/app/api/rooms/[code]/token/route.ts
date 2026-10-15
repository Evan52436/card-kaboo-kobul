import { rooms } from '@/server/deps';
import { codeOf, reply, sessionOf } from '@/server/http';

/**
 * A subscribe-only credential for THIS player's own channel.
 *
 * The capability is scoped to one channel — `kaboo:room:{CODE}:p:{playerId}` —
 * so a player cannot listen to another player's seat even knowing its name.
 * Secrecy does not rest on the channel name being hard to guess; it rests on the
 * token being impossible to widen.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  return reply(await rooms().realtimeToken(codeOf(code), sessionOf(request)));
}
