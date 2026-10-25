import { NextResponse } from 'next/server';
import { requirePlatformAdmin, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { queueProxyTest } from '@/server/profileTasks';
import { describeProxy, parseProxy } from '@/modules/accounts/proxy';

// POST /api/accounts/proxy-test  { proxy: string }
//
// Ask the agent to make one request through the proxy, from the server, and
// report the exit IP, where it is, and any profile or account already using it.
// Returns a task id; the form polls /api/accounts/profile-tasks/[taskId].
// Owner and admin, like creating a profile.

export const POST = withAuth(async (req: Request, caller: Caller) => {
  requirePlatformAdmin(caller);
  const body = await jsonBody<{ proxy?: unknown }>(req);
  const parsed = parseProxy(String(body.proxy ?? ''));
  if (!parsed.ok) return badRequest(parsed.error);
  const taskId = await queueProxyTest(parsed.proxy, caller.uid);
  return NextResponse.json({ taskId, understood: describeProxy(parsed.proxy), rotating: parsed.proxy.rotating }, { status: 202 });
});
