import type { Action } from '@/engine/types';
import { roomError } from '@/protocol';
import { rooms } from '@/server/deps';
import { bodyOf, codeOf, reply, sessionOf } from '@/server/http';

/**
 * Play one move.
 *
 * This is the tap race. Two phones POST here at the same instant, both actions
 * are built from the same revision, and the store's compare-and-set decides
 * which write lands. The loser is told `E_TOO_LATE` — no more than that, because
 * the reason it lost is not the loser's business.
 *
 * The `playerId` in the body is ignored: `room.ts` overwrites it from the
 * session. It is accepted here only so that a client sending it is not an error.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Enough to tell a real action from junk; the engine validates the rest. */
function asAction(raw: unknown): Action | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  return typeof candidate.type === 'string' ? (candidate as unknown as Action) : null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  const body = await bodyOf(request);
  const action = asAction(body.action);
  if (!action) return reply(roomError('E_BAD_REQUEST'));
  return reply(await rooms().act(codeOf(code), sessionOf(request), action));
}
