import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { checkProxy, deleteProxy, PoolError, revealProxy, setDisposed, setNote } from '@/server/proxyPool';
import { curlFor, proxyFormats, proxyUrl } from '@/modules/accounts/proxyPool';

// POST   /api/proxies/:key — { action: 'check' | 'reveal' | 'note' | 'dispose', note?, disposed? }
// DELETE /api/proxies/:key — take an entry off the list (refused while in use).
//
// 'reveal' is the only path that returns a password, and only for a copy.

type Ctx = { params: Promise<{ key: string }> };

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const key = decodeURIComponent((await ctx.params).key);
  const body = await jsonBody<{ action?: string; note?: string; disposed?: boolean }>(req);
  try {
    if (body.action === 'check') return NextResponse.json(await checkProxy(key));
    if (body.action === 'reveal') {
      const p = await revealProxy(key);
      return NextResponse.json({ url: proxyUrl(p), curl: curlFor(p), formats: proxyFormats(p) });
    }
    if (body.action === 'dispose') {
      await setDisposed(key, body.disposed !== false, String(body.note ?? ''));
      return NextResponse.json({ ok: true });
    }
    if (body.action === 'note') {
      await setNote(key, String(body.note ?? ''));
      return NextResponse.json({ ok: true });
    }
    return badRequest('Unknown action.');
  } catch (err) {
    if (err instanceof PoolError) return badRequest(err.message);
    throw err;
  }
});

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  try {
    await deleteProxy(decodeURIComponent((await ctx.params).key));
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PoolError) return badRequest(err.message);
    throw err;
  }
});
