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
//
// CRITICAL: a NEW ProxyAgent is built per request, not memoized. IPRoyal's
// rotating gateway assigns a fresh exit IP per new TCP connection, but undici
// keep-alives connections in a pool — a single reused ProxyAgent pins ~2 exit
// IPs, so a multi-subreddit sweep hammers Reddit from those 2 IPs and trips the
// per-IP 429. Building (and closing) a fresh agent per request forces a fresh
// connection, hence a fresh IP, every time. Do NOT "optimize" this into a
// shared singleton — that reintroduces the 429s this whole file exists to avoid.
// ============================================================

import { ProxyAgent } from 'undici';
import { sleep } from './throttle';

interface ProxyConfig {
  uri: string;
  token?: string;
}

// Parse REDDIT_PROXY_URL once. Cheap and connection-free — the ProxyAgent
// itself is built per request in fetchWithRetry so each opens a fresh tunnel.
let _config: ProxyConfig | null | undefined;
function proxyConfig(): ProxyConfig | null {
  if (_config !== undefined) return _config;
  const raw = process.env.REDDIT_PROXY_URL?.trim();
  if (!raw) {
    _config = null;
    return _config;
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
      _config = null;
      return _config;
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
  _config = token ? { uri, token } : { uri };
  return _config;
}

/** A fresh proxy connection pool for a single request. Null when unconfigured. */
function newDispatcher(): ProxyAgent | null {
  const cfg = proxyConfig();
  return cfg ? new ProxyAgent(cfg) : null;
}

interface RetryOpts {
  maxRetries?: number; // extra attempts after the first (default 2)
  baseDelayMs?: number; // backoff base when no Retry-After header (default 1000)
  maxDelayMs?: number; // cap any single wait (default 4000)
}

// fetch() that retries on HTTP 429. Non-429 responses (incl. other errors)
// are returned as-is for the caller to handle. Each attempt goes through a
// FRESH proxy connection (a new exit IP), so a 429 retry lands on a different
// IP than the one that was throttled.
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 4000 }: RetryOpts = {}
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    // New agent (hence new exit IP) per attempt. See the header note on why this
    // must not be a shared singleton.
    const dispatcher = newDispatcher();
    // `dispatcher` isn't in the standard RequestInit type, but Node's undici-based
    // fetch honors it to select the proxy connection pool.
    const fetchInit = (dispatcher ? { ...init, dispatcher } : init) as RequestInit;
    let res: Response;
    try {
      res = await fetch(url, fetchInit);
    } catch (err) {
      if (dispatcher) await dispatcher.close().catch(() => {});
      throw err;
    }

    if (res.status !== 429 || attempt >= maxRetries) {
      // Returning this response — its body hasn't been read yet. close() is a
      // GRACEFUL shutdown: it waits for the in-flight response body to be
      // consumed before tearing the socket down, so we fire it unawaited and
      // let the caller read res.text() normally. This frees the connection
      // afterward so it can never be reused (and re-pin) for a later request.
      if (dispatcher) void dispatcher.close().catch(() => {});
      return res;
    }

    // 429 and we'll retry: drain+discard this body and close the agent NOW so
    // the next attempt opens a brand-new connection with a fresh exit IP.
    if (dispatcher) {
      try {
        await res.arrayBuffer();
      } catch {
        /* ignore */
      }
      await dispatcher.close().catch(() => {});
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, maxDelayMs)
        : Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    await sleep(waitMs);
    attempt += 1;
  }
}
