// What reaches FIRESTORE, and what no longer reaches the array.
//
// These assert the shape of the query rather than the shape of the result,
// because the bug they exist to prevent is invisible in the result: filtering
// after `.limit()` returns the right rows on small data and the wrong rows —
// having billed for all of them — on real data. A test that only checked the
// returned array would have passed against the code this replaced.
//
// See apps/web/src/modules/covers/queries.ts, and firestore.indexes.json for
// the composite index every shape below requires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  clampLimit,
  coversDraftsQuery,
  coversTriageQuery,
  DRAFT_LIMIT_CEILING,
  TRIAGE_LIMIT_CEILING,
} from '../../apps/web/src/modules/covers/queries.ts';

/**
 * A Firestore query that records instead of executing.
 *
 * Immutable per call, exactly as the real one is: `where` returns a NEW query
 * and a builder that forgot to reassign would silently drop a filter. A fake
 * that mutated in place would hide that mistake.
 */
function fakeQuery(calls = []) {
  return {
    calls,
    where(field, op, value) {
      return fakeQuery([...calls, { kind: 'where', field, op, value }]);
    },
    orderBy(field, direction) {
      return fakeQuery([...calls, { kind: 'orderBy', field, direction }]);
    },
    limit(n) {
      return fakeQuery([...calls, { kind: 'limit', n }]);
    },
  };
}

const wheres = (q) =>
  q.calls.filter((c) => c.kind === 'where').map((c) => `${c.field}${c.op}${c.value}`);
const orderBys = (q) => q.calls.filter((c) => c.kind === 'orderBy');
const limitOf = (q) => q.calls.find((c) => c.kind === 'limit')?.n;

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

test('a draft listing filters by section IN THE QUERY, at the nested path', () => {
  const q = coversDraftsQuery(fakeQuery(), { section: 'nfl-betting-21' });

  assert.deepEqual(wheres(q), ['platform==covers', 'context.section==nfl-betting-21']);
  // The whole point: `section` lives at context.section on the document, and the
  // old code read every draft of every section and then compared this field in
  // JavaScript.
  assert.ok(
    wheres(q).includes('context.section==nfl-betting-21'),
    'section must be a Firestore predicate, not an Array.filter',
  );
});

test('a draft listing is ordered by the query, so the limit keeps the best rows', () => {
  const q = coversDraftsQuery(fakeQuery(), { section: 'nfl-betting-21', limit: 25 });

  assert.deepEqual(orderBys(q), [{ kind: 'orderBy', field: 'context.opportunityScore', direction: 'desc' }]);
  assert.equal(limitOf(q), 25);

  // Ordering must be established BEFORE the limit, or the limit truncates an
  // arbitrary page and the sort only reorders the survivors.
  const kinds = q.calls.map((c) => c.kind);
  assert.ok(
    kinds.indexOf('orderBy') < kinds.indexOf('limit'),
    'orderBy has to come before limit or the ranking is decorative',
  );
});

test('every optional draft filter is a predicate, and none of them is lost', () => {
  const q = coversDraftsQuery(fakeQuery(), {
    runId: 'run1',
    status: 'pending',
    section: 'nfl-betting-21',
  });

  assert.deepEqual(wheres(q), [
    'platform==covers',
    'runId==run1',
    'status==pending',
    'context.section==nfl-betting-21',
  ]);
});

test('an unfiltered draft listing still pins the platform — analyses are shared with Reddit', () => {
  const q = coversDraftsQuery(fakeQuery(), {});
  assert.deepEqual(wheres(q), ['platform==covers']);
});

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------

test('a triage listing asks Firestore for opportunities, not for everything', () => {
  const q = coversTriageQuery(fakeQuery(), { section: 'nfl-betting-21' });

  // This is the single biggest read saving in the module. The funnel rejected
  // 759 of 863 posts as thread-cold on real data; without this predicate the
  // generation path read 500 analyses to work on the dozen that qualified.
  assert.ok(wheres(q).includes('outcome==opportunity'));
  assert.deepEqual(wheres(q), [
    'platform==covers',
    'outcome==opportunity',
    'section==nfl-betting-21',
  ]);
});

test('`all` is the only thing that drops the outcome predicate', () => {
  const q = coversTriageQuery(fakeQuery(), { section: 'nfl-betting-21', all: true });

  assert.deepEqual(wheres(q), ['platform==covers', 'section==nfl-betting-21']);
  assert.ok(
    !wheres(q).some((w) => w.startsWith('outcome')),
    'the screen asking for every outcome must not be narrowed to opportunities',
  );
  // Still ranked: the chips read the top 200 of a ranked set, not 200 arbitrary
  // analyses that a browser then sorts.
  assert.deepEqual(orderBys(q), [{ kind: 'orderBy', field: 'score', direction: 'desc' }]);
});

test('a triage listing carries runId when one is asked for', () => {
  const q = coversTriageQuery(fakeQuery(), { runId: 'run1', section: 'nfl', all: true });
  assert.deepEqual(wheres(q), ['platform==covers', 'runId==run1', 'section==nfl']);
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

test('limits are clamped rather than trusted — Firestore rejects zero and we refuse the whole collection', () => {
  assert.equal(clampLimit(undefined, 100, 500), 100);
  assert.equal(clampLimit(0, 100, 500), 1, 'a limit of 0 is an error, not "no limit"');
  assert.equal(clampLimit(-5, 100, 500), 1);
  assert.equal(clampLimit(9999, 100, 500), 500);
  assert.equal(clampLimit(25, 100, 500), 25);

  assert.equal(limitOf(coversDraftsQuery(fakeQuery(), { limit: 100000 })), DRAFT_LIMIT_CEILING);
  assert.equal(limitOf(coversTriageQuery(fakeQuery(), { limit: 100000 })), TRIAGE_LIMIT_CEILING);
});

// ---------------------------------------------------------------------------
// The indexes these shapes require
// ---------------------------------------------------------------------------

/**
 * A missing composite index does not degrade — Firestore throws
 * FAILED_PRECONDITION and the screen shows an error. So every shape the
 * builders can emit is checked against the deployed index file here, where it
 * costs nothing, rather than in front of somebody.
 */
test('firestore.indexes.json covers every shape these builders can emit', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(readFileSync(resolve(here, '../../firestore.indexes.json'), 'utf8'));

  const declared = new Set(
    config.indexes
      .filter((i) => i.queryScope === 'COLLECTION')
      .map((i) => `${i.collectionGroup}|${i.fields.map((f) => `${f.fieldPath}:${f.order}`).join(',')}`),
  );

  /** The index a built query needs: its equality fields, then its ordering. */
  const required = (collection, q) => {
    const eq = q.calls.filter((c) => c.kind === 'where').map((c) => `${c.field}:ASCENDING`);
    const ob = q.calls
      .filter((c) => c.kind === 'orderBy')
      .map((c) => `${c.field}:${c.direction === 'desc' ? 'DESCENDING' : 'ASCENDING'}`);
    return `${collection}|${[...eq, ...ob].join(',')}`;
  };

  const missing = [];
  const check = (collection, q) => {
    const key = required(collection, q);
    if (!declared.has(key)) missing.push(key);
  };

  const bool = [false, true];
  for (const runId of bool) {
    for (const status of bool) {
      for (const section of bool) {
        check(
          'drafts',
          coversDraftsQuery(fakeQuery(), {
            runId: runId ? 'r' : undefined,
            status: status ? 'pending' : undefined,
            section: section ? 's' : undefined,
          }),
        );
      }
    }
  }

  for (const runId of bool) {
    for (const all of bool) {
      for (const section of bool) {
        check(
          'analyses',
          coversTriageQuery(fakeQuery(), {
            runId: runId ? 'r' : undefined,
            all,
            section: section ? 's' : undefined,
          }),
        );
      }
    }
  }

  assert.deepEqual(missing, [], `no composite index declared for:\n  ${missing.join('\n  ')}`);
});
