import { rooms } from '@/server/deps';
import { codeOf, reply, sessionOf, sinceOf } from '@/server/http';

/**
 * This player's truth: the first load, every poll, and the resync after a
 * reconnect or a suspended tab.
 *
 * Deadlines resolve HERE, inside the read. A serverless function cannot hold a
 * timer across invocations, so the clock only moves when somebody touches the
 * room — which is why the client keeps polling on a heartbeat even while its
 * push channel is healthy. Without that heartbeat a table where everyone is
 * idle would sit in one phase forever.
 *
 * `?since=` is the client's own cursor. A dropped push costs nothing: the cursor
 * did not move, so the next poll still returns the card.
 */

export const runtime = 'nodejs';
/** Per-player and deadline-resolving: caching this would freeze the game. */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  return reply(await rooms().read(codeOf(code), sessionOf(request), sinceOf(request)));
}
