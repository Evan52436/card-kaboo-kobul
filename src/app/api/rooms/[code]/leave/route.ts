import { rooms } from '@/server/deps';
import { codeOf, reply, sessionOf } from '@/server/http';

/**
 * Give up a seat.
 *
 * The two cases are genuinely different and the room layer handles both: before
 * the deal the seat is freed and the host passes to the next arrival, and after
 * it the player is only marked gone — the turn ring is fixed, and the engine
 * autoplays a disconnected seat rather than renumbering everybody.
 *
 * This cannot be relied on for a closed browser tab, which is why the engine
 * treats a silent player as a disconnected one rather than waiting forever.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  return reply(await rooms().leaveRoom(codeOf(code), sessionOf(request)));
}
