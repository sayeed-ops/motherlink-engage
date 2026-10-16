// Network failures, said in a way someone can act on.
//
// Node's fetch reports a broken connection as a bare TypeError — "fetch failed"
// when the connection broke before a reply, "terminated" when it broke while
// the reply was arriving — and puts the useful part ("other side closed",
// ECONNRESET, a proxy refusing the tunnel) on `err.cause`. Passed on as
// `err.message`, that cause is lost, and so is which service it was: comment
// karma scans filed "terminated" with nothing to say whether Reddit, Crawlzo or
// the model had dropped the line (2026-10-16).
//
// PURE — no imports, so client and server code and the unit tests can all use it.

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
]);

function causeOf(err: unknown): { code?: string; message?: string } | null {
  const cause = err && typeof err === 'object' ? (err as { cause?: unknown }).cause : null;
  return cause && typeof cause === 'object' ? (cause as { code?: string; message?: string }) : null;
}

/** A dropped or refused connection — worth one more try. An HTTP error status
 *  is not: that is the service answering, and it answers the same way twice. */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message === 'fetch failed' || err.message === 'terminated') return true;
  const code = causeOf(err)?.code ?? (err as { code?: string }).code;
  return !!code && TRANSIENT_CODES.has(code);
}

/** "<service>: terminated (other side closed)" — what broke, where, and why. */
export function describeNetworkError(service: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = causeOf(err);
  const why = [cause?.code, cause?.message].filter((s) => s && s !== message).join(' ');
  return `${service}: ${message}${why ? ` (${why})` : ''}`;
}

/** Run `fn`, and once more after a short pause if it failed on the network. */
export async function withNetworkRetry<T>(fn: () => Promise<T>, { retries = 1, delayMs = 1500 } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransientNetworkError(err)) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
