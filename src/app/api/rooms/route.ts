import { rooms } from '@/server/deps';
import { bodyOf, reply } from '@/server/http';

/**
 * Create a room and take seat 1.
 *
 * No session is required, because there is nothing yet to be a session for —
 * this call mints one and hands it back in the body.
 */

export const runtime = 'nodejs';
/** Session-bearing and per-request: never cache. */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const body = await bodyOf(request);
  return reply(await rooms().createRoom(body.name));
}
