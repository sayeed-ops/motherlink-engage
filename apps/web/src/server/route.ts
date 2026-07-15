import 'server-only';

import { NextResponse } from 'next/server';
import { AuthError, requireCaller, type Caller } from './auth';

// Route-handler plumbing.
//
// The point of this file is that authentication is not something a route
// remembers to do. In ML Studio every API route was written without it, and
// nothing in the code makes that omission visible. Here a handler cannot run
// without a verified Caller, because it only ever receives one as an argument.

export type Handler<T> = (req: Request, caller: Caller, ctx: T) => Promise<Response>;

/**
 * Wrap a route handler so it only runs for a verified, provisioned caller.
 *
 * Also normalises error handling: AuthError carries its own status, anything
 * else is a 500 whose details are logged but never returned. Leaking internals
 * in an error body is a small hole that tends to widen.
 */
export function withAuth<T = unknown>(handler: Handler<T>) {
  return async (req: Request, ctx: T): Promise<Response> => {
    let caller: Caller;
    try {
      caller = await requireCaller(req);
    } catch (err) {
      if (err instanceof AuthError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      console.error('auth failure:', err);
      return NextResponse.json({ error: 'Authentication failed.' }, { status: 401 });
    }

    try {
      return await handler(req, caller, ctx);
    } catch (err) {
      if (err instanceof AuthError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      console.error('unhandled route error:', err);
      return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
    }
  };
}

/** Parse a JSON body, or throw a 400-shaped error. */
export async function jsonBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new BadRequest('Request body must be valid JSON.');
  }
}

export class BadRequest extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

export function badRequest(message: string): Response {
  return NextResponse.json({ error: message }, { status: 400 });
}
