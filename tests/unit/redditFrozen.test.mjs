// Reddit behaviour is FROZEN. This file is the lock.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// `modules/forum/*` is a shared core: Reddit and Covers both run on it, by
// design, since the phase-0 seam lift. That sharing is what stops the second
// platform being a second build — and it is also a live route by which work on
// Covers can silently change what Reddit does.
//
// It already happened once. Phase 4 corrected `SPECIFIC_RE` in validate.ts,
// because its trailing `\b` sat outside the alternation and a percentage
// therefore never matched in prose. The fix was right for Covers, where claim
// verification depends on catching a stated figure. It was also an unrequested
// change to the Reddit gate, made in service of another platform, and nothing in
// the suite objected — every Reddit test still passed, because none of them
// asserted the behaviour that changed.
//
// So: this file asserts the Reddit-visible behaviour of the shared surface,
// including the parts that are WRONG. A test that pins a known weakness looks
// strange until you remember what it is for — the operator's instruction is
// "no behavioural change to Reddit through modules/forum/* without flagging it
// first", and a lock that only holds the good behaviour is not a lock.
//
// ⚠️ IF A TEST HERE FAILS, THE FIX IS NOT TO UPDATE THE TEST. It is to ask
// whether Reddit was supposed to change. If it was, the operator says so and
// the expectation moves with a note saying who approved it.
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractClaims,
  validateComment,
  DEFAULT_SPECIFIC_RE,
  STRICT_SPECIFIC_RE,
} from '../../apps/web/src/modules/forum/reply/validate.ts';
import { profileRoom, targetLength } from '../../apps/web/src/modules/forum/reply/roomProfile.ts';

// A room with enough comments to be measured, so the length band is real.
const comment = (body, score = 5) => ({
  commentId: `c${Math.random()}`,
  body,
  score,
  isOp: false,
  author: 'someone',
  createdAtMs: 0,
});

const ROOM = profileRoom([
  comment('yeah that happened to me last year and it sorted itself out after a week', 12),
  comment('depends how you filed it honestly, mine took about that long too', 9),
  comment('worth checking the letter they sent, it usually says which office', 7),
  comment('same, took ages and then arrived with no explanation at all', 6),
  comment('i would just call them, the online form goes nowhere', 4),
  comment('no idea sorry', 1),
]);
const LENGTH = targetLength(ROOM);

const ctx = (over = {}) => ({ length: LENGTH, profile: ROOM, ...over });

// ---------------------------------------------------------------------------
// The pattern that changed, and must not change again
// ---------------------------------------------------------------------------

test('FROZEN: Reddit does not flag a percentage followed by a space', () => {
  // ⚠️ THIS IS A KNOWN WEAKNESS, PINNED DELIBERATELY. The trailing `\\b` in
  // DEFAULT_SPECIFIC_RE demands a word character after `%`, so "92% of people"
  // slips through as a defensible assertion. Covers corrects this with
  // STRICT_SPECIFIC_RE; Reddit keeps the original until somebody decides
  // otherwise on purpose.
  const claims = extractClaims('Around 92% of people never bother with it.');
  assert.equal(claims[0].kind, 'assertion');
  assert.equal(claims[0].defensible, true);
});

test('FROZEN: Reddit still flags the forms it always flagged', () => {
  // The freeze is not "nothing is checked" — these were caught before Covers
  // existed and must still be.
  for (const line of [
    'It costs about £200 to sort out.',
    'The whole thing took 6 months from start to finish.',
    'Studies show that most people give up.',
  ]) {
    const claim = extractClaims(line)[0];
    assert.equal(claim.defensible, false, line);
  }
});

test('FROZEN: a first-person specific stays defensible', () => {
  // The design wants specifics the speaker LIVED — "took me about six months,
  // maybe £200" is the best thing a comment can contain.
  const claim = extractClaims('It took me about 6 months and cost me £200.')[0];
  assert.equal(claim.kind, 'experience');
  assert.equal(claim.defensible, true);
});

test('the two patterns are genuinely different, and Covers has the strict one', () => {
  // If these ever agree, the split has been collapsed and Reddit is no longer
  // independently controllable.
  assert.equal(DEFAULT_SPECIFIC_RE.test('92% of people'), false);
  assert.equal(STRICT_SPECIFIC_RE.test('92% of people'), true);
});

test('extractClaims defaults to the REDDIT pattern when none is passed', () => {
  // Every Reddit caller omits the argument. If the default ever became the
  // strict pattern, every Reddit caller would change behaviour at once and
  // nothing else in the suite would notice.
  assert.deepEqual(
    extractClaims('Around 92% of people never bother with it.'),
    extractClaims('Around 92% of people never bother with it.', DEFAULT_SPECIFIC_RE),
  );
});

// ---------------------------------------------------------------------------
// The whole Reddit-visible gate
// ---------------------------------------------------------------------------

test('FROZEN: an ordinary comment passes the Reddit mechanical gate', () => {
  const { ok } = validateComment(
    'took about a week for mine, the letter turns up eventually with no warning',
    ctx(),
  );
  assert.equal(ok, true);
});

test('FROZEN: the Reddit gate bans every brand mention, with no variant exception', () => {
  // Covers needed a variant-aware version of this and got its OWN gate in
  // modules/covers/compliance.ts rather than a flag on this one. If a variant
  // parameter ever appears here, a karma account can name a client.
  const { ok, failures } = validateComment('I used Northwind for mine and it was fine', {
    ...ctx(),
    bannedTerms: ['Northwind'],
  });
  assert.equal(ok, false);
  assert.ok(failures.some((f) => f.code === 'brand'));
});

test('FROZEN: the Reddit gate bans every link, unconditionally', () => {
  const { failures } = validateComment('have a look at https://example.com for this', ctx());
  assert.ok(failures.some((f) => f.code === 'link'));
});

test('FROZEN: length is measured from the room, not chosen', () => {
  const short = validateComment('yeah', ctx());
  assert.ok(short.failures.some((f) => f.code === 'too-short'));

  const long = validateComment(Array.from({ length: 200 }, () => 'word').join(' '), ctx());
  assert.ok(long.failures.some((f) => f.code === 'too-long'));
});

test('FROZEN: the assistant tells and sign-offs still fire', () => {
  const { failures } = validateComment(
    'Great question! It is important to note that this varies. Hope this helps!',
    ctx(),
  );
  const codes = failures.map((f) => f.code);
  assert.ok(codes.includes('banned-opener'));
  assert.ok(codes.includes('assistant-tell'));
  assert.ok(codes.includes('banned-closer'));
});

// ---------------------------------------------------------------------------
// The import boundary
// ---------------------------------------------------------------------------

test('FROZEN: nothing in the Reddit module imports the knowledge library', async () => {
  // The asset library, the claim ledger and retrieval are Covers-only. Reddit
  // runs on `projects/{id}/sources` and must keep running on it — an import
  // appearing here would mean the two knowledge systems had started to merge.
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  // fileURLToPath, not .pathname — the repo lives under "Ai projects" and a
  // percent-encoded space is not a directory anybody can read.
  const root = fileURLToPath(new URL('../../apps/web/src/modules/reddit/', import.meta.url));
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      const src = readFileSync(full, 'utf8');
      if (/from '@\/modules\/(knowledge|covers)\//.test(src)) offenders.push(full);
    }
  };

  walk(root);
  assert.deepEqual(offenders, [], 'Reddit must not import knowledge or covers modules');
});
