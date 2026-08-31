// What this server is allowed to fetch.
//
// PURE, and it lives here rather than in server/knowledge.ts for one reason: it
// is a security control, and a security control that cannot be unit-tested
// without firebase-admin does not get unit-tested.
//
// ════════════════════════════════════════════════════════════════════════════
// SSRF, STATED PLAINLY
//
// Ingestion takes a URL from an authenticated user and fetches it FROM INSIDE
// OUR OWN NETWORK, then shows the response back to them through the proposal.
// Without this check, a project manager could point it at a cloud metadata
// endpoint or an internal service and read the result out. Holding
// knowledge.manage is permission to describe a client's website; it is not
// permission to make the server fetch arbitrary hosts on their behalf.
//
// WHAT THIS DOES NOT DO, and it matters that this is written down: the check is
// on the hostname, so a PUBLIC name that resolves to a private address still
// gets through. Node's fetch offers no hook between DNS resolution and connect,
// so closing that properly means resolving first and connecting to the literal
// address — a different and much larger change. This stops the direct forms,
// which is what someone already holding the permission would actually reach for.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Why a page could not be read.
 *
 * The distinction that earns this type its existence is `canPaste` below: some
 * of these mean "we cannot read it, but a person can", and some mean "this URL
 * has no business being read at all". Collapsing them would offer the manual
 * paste route for `http://169.254.169.254/`, which is the one address the guard
 * above exists to refuse.
 */
export type FetchFailure =
  | 'bad-url' // not a URL, or not http(s)
  | 'private-address' // the SSRF guard refused it
  | 'blocked' // 401/403/429/451 — the site is refusing US specifically
  | 'bad-status' // some other non-2xx
  | 'unreachable' // DNS, TLS, connection
  | 'timeout'
  | 'not-html' // a PDF, an image, a download
  | 'too-large'
  | 'no-text'; // HTTP 200, real markup, no prose — a JavaScript shell

/**
 * Can a human legitimately supply this page's content by hand instead?
 *
 * TRUE for every failure that is about US being unable to read a real page —
 * blocked, slow, JavaScript-rendered, too big. A person with a browser can see
 * that page; we cannot; that asymmetry is the whole reason the manual route
 * exists.
 *
 * FALSE for the two failures that are about the URL ITSELF. Pasting content
 * "from" a private address or a `file://` path would attach text to a source
 * nobody can ever re-check, and would let the manual route launder exactly the
 * thing assertPublicHttpUrl refuses.
 */
export function canPaste(code: FetchFailure): boolean {
  return code !== 'bad-url' && code !== 'private-address';
}

/**
 * 400 — the URL is wrong or not allowed; the caller can fix it.
 * 502 — we tried and the far end failed; the caller cannot.
 *
 * NO PARAMETER PROPERTY on the constructor, deliberately. Node's
 * --experimental-strip-types runs in strip-only mode and rejects
 * `constructor(readonly status: ...)` outright, so writing it the idiomatic way
 * would make this file unimportable from the unit tests — and the entire reason
 * it was split out of server/knowledge.ts is so that the SSRF guard below can be
 * tested. LlmError and CrawlzoError use the shorthand because nothing tests them.
 */
export class KnowledgeFetchError extends Error {
  readonly status: 400 | 502;
  readonly code: FetchFailure;

  constructor(status: 400 | 502, code: FetchFailure, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'KnowledgeFetchError';
  }

  /** May the operator supply this page by hand? */
  get pasteable(): boolean {
    return canPaste(this.code);
  }
}

/** Refuse anything that is not a public web page. Throws rather than returning
 *  a boolean, so a caller cannot forget to check the result. */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new KnowledgeFetchError(400, 'bad-url', 'That is not a valid URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new KnowledgeFetchError(400, 'bad-url', 'Only http:// and https:// pages can be read.');
  }

  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    // IPv4 private and link-local ranges, plus loopback.
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    // IPv6 loopback and unique-local.
    host === '::1' ||
    host === '[::1]' ||
    /^\[?f[cd][0-9a-f]{2}:/i.test(host);

  if (blocked) {
    throw new KnowledgeFetchError(
      400,
      'private-address',
      'That address is not reachable from here. Use the public URL of the page.',
    );
  }
  return url;
}
