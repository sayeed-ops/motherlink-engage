// ============================================================
// SERVER-ONLY Reddit fetch helper.
//
// Imports `undici` (which needs node:net) — must never be pulled into a client
// bundle. Only API routes import this. Client-safe helpers (sleep, runThrottled)
// live in ./throttle.
//
// Routes requests through a residential proxy when REDDIT_PROXY_URL is set
// (sidesteps the per-IP rate limit via a fresh exit IP per request), and
// retries HTTP 429 honoring Retry-After.
// ============================================================

import { ProxyAgent } from 'undici';
import { sleep } from './throttle';

// Built once and reused. No-op (direct fetch) when the env var is absent.
let _dispatcher: ProxyAgent | null | undefined;
function proxyDispatcher(): ProxyAgent | null {
  if (_dispatcher !== undefined) return _dispatcher;
  const raw = process.env.REDDIT_PROXY_URL?.trim();
  if (!raw) {
    _dispatcher = null;
    return _dispatcher;
  }
  // Accept either `http://user:pass@host:port` or IPRoyal's "Copy list"
  // format `host:port:user:pass`. Auth is sent as a Basic token (not embedded
  // in the URL) so special characters in the password never break parsing.
  let host = '';
  let port = '';
  let user = '';
  let pass = '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      host = u.hostname;
      port = u.port;
      user = decodeURIComponent(u.username);
      pass = decodeURIComponent(u.password);
    } catch {
      _dispatcher = null;
      return _dispatcher;
    }
  } else {
    const parts = raw.split(':');
    host = parts[0] ?? '';
    port = parts[1] ?? '';
    user = parts[2] ?? '';
    pass = parts.slice(3).join(':'); // tolerate ':' in password (shouldn't occur)
  }
  const uri = `http://${host}${port ? `:${port}` : ''}`;
  const token =
    user || pass ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` : undefined;
  _dispatcher = new ProxyAgent(token ? { uri, token } : uri);
  return _dispatcher;
}

interface RetryOpts {
  maxRetries?: number; // extra attempts after the first (default 2)
  baseDelayMs?: number; // backoff base when no Retry-After header (default 1000)
  maxDelayMs?: number; // cap any single wait (default 4000)
}

// fetch() that retries on HTTP 429. Non-429 responses (incl. other errors)
// are returned as-is for the caller to handle. Routes through the residential
// proxy if one is configured.
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  { maxRetries = 2, baseDelayMs = 1000, maxDelayMs = 4000 }: RetryOpts = {}
): Promise<Response> {
  const dispatcher = proxyDispatcher();
  // `dispatcher` isn't in the standard RequestInit type, but Node's undici-based
  // fetch honors it to select the proxy connection pool.
  const fetchInit = (dispatcher ? { ...init, dispatcher } : init) as RequestInit;
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, fetchInit);
    if (res.status !== 429 || attempt >= maxRetries) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, maxDelayMs)
        : Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    await sleep(waitMs);
    attempt += 1;
  }
}
