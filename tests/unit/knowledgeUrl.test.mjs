// What the server is allowed to fetch on a user's say-so.
//
// This is the SSRF guard. Ingestion takes a URL from an authenticated user and
// fetches it from inside our own network, then shows them the response — so the
// list below is not hypothetical, it is the set of addresses somebody could
// otherwise read out of our infrastructure through a proposal.
//
// The guard lives in modules/knowledge/url.ts rather than server/knowledge.ts
// for exactly this file's sake: a security control that cannot be tested without
// firebase-admin does not get tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertPublicHttpUrl,
  canPaste,
  KnowledgeFetchError,
} from '../../apps/web/src/modules/knowledge/url.ts';

const rejects = (url) => {
  assert.throws(
    () => assertPublicHttpUrl(url),
    (err) => err instanceof KnowledgeFetchError && err.status === 400,
    `${url} should have been refused`,
  );
};

/** The refusal a rejected URL produced, for asserting on its code. */
const refusalFor = (url) => {
  try {
    assertPublicHttpUrl(url);
  } catch (err) {
    return err;
  }
  throw new Error(`${url} was not refused`);
};

const accepts = (url) => {
  assert.doesNotThrow(() => assertPublicHttpUrl(url), `${url} should have been allowed`);
};

test('ordinary public pages are allowed', () => {
  accepts('https://help.northwind.example/en/articles/4872560');
  accepts('http://example.com/a/b?c=d#e');
  accepts('https://sub.domain.example.co.uk/page');
});

test('only http and https', () => {
  rejects('file:///etc/passwd');
  rejects('ftp://example.com/x');
  rejects('data:text/html,<h1>hi</h1>');
  rejects('javascript:alert(1)');
  rejects('gopher://example.com/');
});

test('loopback in every spelling', () => {
  rejects('http://localhost/');
  rejects('http://localhost:8080/admin');
  rejects('http://api.localhost/');
  rejects('http://127.0.0.1/');
  rejects('http://127.1.2.3/');
  rejects('http://[::1]/');
});

test('private IPv4 ranges', () => {
  rejects('http://10.0.0.1/');
  rejects('http://192.168.1.1/');
  rejects('http://172.16.0.1/');
  rejects('http://172.31.255.254/');
});

test('the cloud metadata address', () => {
  // The single most valuable target on this list: 169.254.169.254 serves
  // instance credentials on most cloud providers.
  rejects('http://169.254.169.254/latest/meta-data/');
  rejects('http://169.254.169.254/computeMetadata/v1/');
});

test('addresses just OUTSIDE the private ranges stay allowed', () => {
  // A guard that over-blocks gets switched off. 172.15 and 172.32 are public.
  accepts('http://172.15.0.1/');
  accepts('http://172.32.0.1/');
  accepts('http://11.0.0.1/');
  accepts('http://193.168.1.1/');
});

test('internal-looking suffixes', () => {
  rejects('http://service.internal/');
  rejects('http://printer.local/');
  rejects('http://0.0.0.0/');
});

test('IPv6 unique-local', () => {
  rejects('http://[fd00::1]/');
  rejects('http://[fc00::1]/');
});

test('a malformed URL is refused rather than throwing something else', () => {
  assert.throws(
    () => assertPublicHttpUrl('not a url at all'),
    (err) => err instanceof KnowledgeFetchError && /valid URL/i.test(err.message),
  );
});

test('the check is case-insensitive on the host', () => {
  rejects('http://LOCALHOST/');
  rejects('http://Service.INTERNAL/');
});

test('it returns the parsed URL so callers fetch what was checked', () => {
  // Returning the URL rather than a boolean is what stops a caller validating
  // one string and fetching another.
  const url = assertPublicHttpUrl('https://example.com/a');
  assert.equal(url.hostname, 'example.com');
  assert.equal(url.protocol, 'https:');
});

// ── the manual-paste boundary ──────────────────────────────────────────────
//
// A real 403 from a client help centre forced the manual route to exist. These
// cases are about the ONE way that route could become dangerous: being offered
// for a URL the guard above refuses, which would let pasted text be attached to
// an address nobody can ever re-check.

test('failures about the far end allow a person to paste instead', () => {
  // We could not read a page that a human plainly can. That asymmetry is the
  // entire justification for the manual route.
  assert.equal(canPaste('blocked'), true, 'a 403 is the case this was built for');
  assert.equal(canPaste('timeout'), true);
  assert.equal(canPaste('unreachable'), true);
  assert.equal(canPaste('no-text'), true, 'a JavaScript shell is readable in a browser');
  assert.equal(canPaste('too-large'), true);
  assert.equal(canPaste('not-html'), true);
  assert.equal(canPaste('bad-status'), true);
});

test('failures about the URL ITSELF never allow pasting', () => {
  // Pasting "from" a private address would launder past the SSRF guard and
  // leave a source that can never be verified by anyone, ever.
  assert.equal(canPaste('bad-url'), false);
  assert.equal(canPaste('private-address'), false);
});

test('a refused address reports a code that forbids pasting', () => {
  // The end-to-end version of the rule: the guard's own refusals must carry
  // codes the paste offer will decline, not merely codes that happen to.
  for (const url of ['http://169.254.169.254/', 'http://localhost/', 'http://10.0.0.1/', 'file:///etc/passwd']) {
    const err = refusalFor(url);
    assert.equal(err.pasteable, false, `${url} must not be offered the manual route`);
    assert.equal(canPaste(err.code), false);
  }
});

test('the error carries its code and its paste eligibility together', () => {
  const err = new KnowledgeFetchError(502, 'blocked', 'refused');
  assert.equal(err.status, 502);
  assert.equal(err.code, 'blocked');
  assert.equal(err.pasteable, true);
});
