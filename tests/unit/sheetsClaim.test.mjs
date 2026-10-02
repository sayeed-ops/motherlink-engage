// Claiming a sheet row — the transaction, against a fake Firestore.
//
// This is the part worth testing without a browser or a network. The Mention ID
// is handed out by advancing a counter on the project document, and two jobs
// that finish in the same second must not be given the same one: a client's
// sheet with two RM292-1-17 rows is a quiet, permanent wrong answer that nobody
// notices until they try to reconcile it.
//
// It is also the part that decides a retry is safe. Everything here runs AFTER
// a comment is already posted, so no path may ever fail a job.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createStore } from '../../apps/poster-agent/agent-core.mjs';

// ---------------------------------------------------------------------------
// A Firestore small enough to read
// ---------------------------------------------------------------------------

const DELETE = Symbol('FieldValue.delete');

function fakeDb(seed = {}) {
  const docs = new Map(Object.entries(seed));

  const apply = (path, patch, merge) => {
    const before = docs.get(path) ?? {};
    const next = merge ? { ...before } : { ...before };
    for (const [k, v] of Object.entries(patch)) {
      if (v === DELETE) delete next[k];
      // Firestore merges one level of a plain object under set({merge:true}),
      // which is how `sheet: { nextMention }` updates one field and leaves the
      // rest of the map alone.
      else if (merge && v && typeof v === 'object' && !Array.isArray(v)) next[k] = { ...(before[k] ?? {}), ...v };
      else next[k] = v;
    }
    docs.set(path, next);
  };

  const makeRef = (path) => ({
    id: path.split('/').pop(),
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    update: async (patch) => apply(path, patch, false),
    set: async (patch, opts) => apply(path, patch, opts?.merge === true),
  });

  return {
    docs,
    ref: makeRef,
    collection: (name) => ({
      doc: (id) => makeRef(`${name}/${id}`),
      where: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
    }),
    async runTransaction(fn) {
      // Serialised, like the real thing: a transaction sees every write the one
      // before it committed.
      return fn({
        get: async (ref) => ref.get(),
        update: (ref, patch) => apply(ref.path, patch, false),
        set: (ref, patch, opts) => apply(ref.path, patch, opts?.merge === true),
      });
    },
  };
}

const FieldValue = { serverTimestamp: () => 'TS', delete: () => DELETE };
const Timestamp = { fromMillis: (ms) => ({ toMillis: () => ms }) };

const POSTED_JOB = {
  status: 'posted',
  projectId: 'p1',
  sheetStatus: 'pending',
  sheetRow: { kind: 'brand', board: 'r/gambling', commentText: 'hi' },
  permalink: 'https://reddit.com/r/gambling/comments/a/b/c1',
  completedAt: { toMillis: () => 1_700_000_000_000 },
};

const SHEET_ON = { sheet: { enabled: true, spreadsheetId: 'SS', tabName: 'Posts', mentionPrefix: 'RM292-1', nextMention: 17 } };

const setup = (jobs, project = SHEET_ON) => {
  const seed = { 'projects/p1': project };
  for (const [id, job] of Object.entries(jobs)) seed[`jobs/${id}`] = job;
  const db = fakeDb(seed);
  return { db, store: createStore({ db, FieldValue, Timestamp }) };
};

const STALE = 120_000;
const NOW = 1_700_000_100_000;

// ---------------------------------------------------------------------------

test('a claim hands out the project’s next number and advances the counter', async () => {
  const { db, store } = setup({ j1: POSTED_JOB });
  const claim = await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE);

  assert.equal(claim.number, 17);
  assert.equal(claim.mentionPrefix, 'RM292-1');
  assert.equal(claim.spreadsheetId, 'SS');
  assert.equal(claim.retry, false, 'a first claim has nothing to look for in the sheet');
  assert.equal(claim.postedAtMs, 1_700_000_000_000, 'the row is dated when the comment went up, not now');
  assert.equal(db.docs.get('projects/p1').sheet.nextMention, 18);
  assert.equal(db.docs.get('jobs/j1').sheetStatus, 'writing');
  assert.equal(db.docs.get('jobs/j1').sheetMentionNumber, 17);
});

test('two comments finishing together never get the same Mention ID', async () => {
  const { db, store } = setup({ j1: POSTED_JOB, j2: { ...POSTED_JOB, permalink: 'https://x/c2' } });
  const a = await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE);
  const b = await store.claimSheetRow(db.ref('jobs/j2'), NOW, STALE);

  assert.equal(a.number, 17);
  assert.equal(b.number, 18);
  assert.equal(db.docs.get('projects/p1').sheet.nextMention, 19);
});

test('a row already in the sheet is not claimed again', async () => {
  const { db, store } = setup({ j1: { ...POSTED_JOB, sheetStatus: 'written' } });
  assert.equal(await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE), null);
});

test('a job with no row to write is never claimed', async () => {
  const { db, store } = setup({
    off: { ...POSTED_JOB, sheetStatus: 'off', sheetRow: undefined },
    noPayload: { ...POSTED_JOB, sheetRow: undefined },
    // A dry run fails its job rather than posting, so its row must never go out.
    failed: { ...POSTED_JOB, status: 'failed' },
  });
  for (const id of ['off', 'noPayload', 'failed']) {
    assert.equal(await store.claimSheetRow(db.ref(`jobs/${id}`), NOW, STALE), null, id);
  }
});

test('a claim another process is still holding is left alone', async () => {
  const { db, store } = setup({ j1: { ...POSTED_JOB, sheetStatus: 'writing', sheetClaimedAtMs: NOW - 1000, sheetMentionNumber: 17 } });
  assert.equal(await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE), null);
});

test('a claim whose process died is taken over, keeping the SAME number', async () => {
  // Burning a second number would leave a gap and, worse, make a duplicate row
  // undetectable — the recovery below is what looks for the id in the sheet.
  const { db, store } = setup({
    j1: { ...POSTED_JOB, sheetStatus: 'writing', sheetClaimedAtMs: NOW - STALE - 1, sheetMentionNumber: 17 },
  });
  const claim = await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE);

  assert.equal(claim.number, 17);
  assert.equal(claim.retry, true, 'the caller must look for this row before writing it again');
  assert.equal(db.docs.get('projects/p1').sheet.nextMention, 17, 'the counter did not move');
});

test('a retry after a failure reuses its number rather than taking a new one', async () => {
  const { db, store } = setup({
    j1: { ...POSTED_JOB, sheetStatus: 'pending', sheetMentionNumber: 17, sheetAttempts: 2 },
  });
  const claim = await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE);

  assert.equal(claim.number, 17);
  assert.equal(claim.attempts, 2);
  assert.equal(claim.retry, true);
  assert.equal(db.docs.get('projects/p1').sheet.nextMention, 17);
});

test('a sheet switched off between posting and writing stops the row, permanently', async () => {
  // Not an error and not a pending row swept forever: somebody said no.
  const { db, store } = setup({ j1: POSTED_JOB }, { sheet: { enabled: false, spreadsheetId: 'SS' } });
  assert.equal(await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE), null);
  assert.equal(db.docs.get('jobs/j1').sheetStatus, 'off');
});

test('a project that never linked a sheet is treated the same way', async () => {
  const { db, store } = setup({ j1: POSTED_JOB }, { sheet: { enabled: true, spreadsheetId: '' } });
  assert.equal(await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE), null);
  assert.equal(db.docs.get('jobs/j1').sheetStatus, 'off');
});

test('a missing project doc does not throw — the comment is already posted', async () => {
  const db = fakeDb({ 'jobs/j1': POSTED_JOB });
  const store = createStore({ db, FieldValue, Timestamp });
  assert.equal(await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE), null);
});

test('a written row clears the error and stamps both the job and the project', async () => {
  const { db, store } = setup({ j1: { ...POSTED_JOB, sheetStatus: 'writing', sheetError: 'old failure' } });
  await store.sheetRowWritten(db.ref('jobs/j1'), 'p1', NOW);

  const job = db.docs.get('jobs/j1');
  assert.equal(job.sheetStatus, 'written');
  assert.equal(job.sheetWrittenAtMs, NOW);
  assert.ok(!('sheetError' in job), 'a stale error must not outlive the row that fixed it');
  assert.equal(db.docs.get('projects/p1').sheet.lastWrittenAtMs, NOW);
  assert.equal(db.docs.get('projects/p1').sheet.lastError, null);
  assert.equal(db.docs.get('projects/p1').sheet.spreadsheetId, 'SS', 'the rest of the settings survived the merge');
});

test('a failure goes back in the queue until the attempts run out', async () => {
  const { db, store } = setup({ j1: POSTED_JOB });

  await store.sheetRowFailed(db.ref('jobs/j1'), 'p1', 'not shared', 3, 5);
  assert.equal(db.docs.get('jobs/j1').sheetStatus, 'pending');
  assert.equal(db.docs.get('jobs/j1').sheetAttempts, 3);
  assert.equal(db.docs.get('projects/p1').sheet.lastError, 'not shared');

  await store.sheetRowFailed(db.ref('jobs/j1'), 'p1', 'not shared', 5, 5);
  assert.equal(db.docs.get('jobs/j1').sheetStatus, 'failed', 'it stops retrying and waits for a person');
});

test('a failure message is bounded before it is stored', async () => {
  const { db, store } = setup({ j1: POSTED_JOB });
  await store.sheetRowFailed(db.ref('jobs/j1'), 'p1', 'x'.repeat(5000), 1, 5);
  assert.equal(db.docs.get('jobs/j1').sheetError.length, 400);
});

// ---------------------------------------------------------------------------
// Brand-only sheets
// ---------------------------------------------------------------------------

const GROWTH_JOB = { ...POSTED_JOB, sheetRow: { ...POSTED_JOB.sheetRow, kind: 'growth' } };
const BRAND_ONLY = { sheet: { ...SHEET_ON.sheet, includeGrowth: false } };

test('with growth off, a growth reply is skipped and BURNS NO MENTION ID', async () => {
  // The number is the point. A client reading RM292-1-14 then RM292-1-16 would
  // reasonably ask what happened to 15, and the honest answer would be "a reply
  // you are not allowed to see". The skip happens before the counter moves.
  const { db, store } = setup({ j1: GROWTH_JOB }, BRAND_ONLY);
  assert.equal(await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE), null);

  assert.equal(db.docs.get('jobs/j1').sheetStatus, 'skipped');
  assert.equal(db.docs.get('jobs/j1').sheetSkipReason, 'growth');
  assert.equal(db.docs.get('projects/p1').sheet.nextMention, 17, 'the counter did not move');
  assert.ok(!('sheetMentionNumber' in db.docs.get('jobs/j1')), 'and no number was written onto the job');
});

test('with growth off, a brand reply is still written, with the next number', async () => {
  const { db, store } = setup({ j1: POSTED_JOB }, BRAND_ONLY);
  const claim = await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE);
  assert.equal(claim.number, 17);
  assert.equal(db.docs.get('projects/p1').sheet.nextMention, 18);
});

test('with growth on, a growth reply is written like any other', async () => {
  const { db, store } = setup({ j1: GROWTH_JOB });
  const claim = await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE);
  assert.equal(claim.number, 17);
});

test('a sheet with no includeGrowth setting records growth replies', async () => {
  // Absent is ON, the same rule the app reads. A sheet set up before the toggle
  // existed must not quietly start dropping rows.
  const { db, store } = setup({ j1: GROWTH_JOB }, { sheet: { enabled: true, spreadsheetId: 'SS', nextMention: 5 } });
  const claim = await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE);
  assert.equal(claim.number, 5);
});

test('a skipped row stays skipped — it is not swept up again', async () => {
  const { db, store } = setup({ j1: { ...GROWTH_JOB, sheetStatus: 'skipped' } }, BRAND_ONLY);
  assert.equal(await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE), null);
  assert.equal(db.docs.get('jobs/j1').sheetStatus, 'skipped');
});

test('turning growth ON does not retroactively write a reply already skipped', async () => {
  // Deliberate: the row would land at the bottom of the sheet under an old
  // date, weeks after the fact. The payload is still on the job, so a backfill
  // remains possible — it is just not something a checkbox does silently.
  const { db, store } = setup({ j1: { ...GROWTH_JOB, sheetStatus: 'skipped' } }, SHEET_ON);
  assert.equal(await store.claimSheetRow(db.ref('jobs/j1'), NOW, STALE), null);
});
