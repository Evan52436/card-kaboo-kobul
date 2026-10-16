import { rooms } from '@/server/deps';
import { bodyOf, codeOf, reply, sessionOf } from '@/server/http';

/**
 * The host deals. Host only, at least two players, once.
 *
 * This is the moment the roster freezes: the engine has no join action, so
 * everyone who is going to play must already be seated when this returns.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  // The host's choice of deck count rides in the body; `startRoom` keeps only that.
  return reply(await rooms().startRoom(codeOf(code), sessionOf(request), await bodyOf(request)));
}
