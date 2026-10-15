import { rooms } from '@/server/deps';
import { bodyOf, codeOf, reply } from '@/server/http';

/**
 * Take the next free seat in an existing room.
 *
 * No session required: joining is how a session comes into being. The room code
 * in the URL is the credential here, which is the whole product — someone reads
 * four characters out loud and the other players type them in.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  const body = await bodyOf(request);
  return reply(await rooms().joinRoom(codeOf(code), body.name));
}
