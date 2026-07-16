// Firestore security-rules tests for Motherlink Engage.
//
// These exist to prove the central claim of the migration: that a user with
// access to one client's project cannot reach another client's data. In ML
// Studio that claim is false by construction — every Reddit collection is
// `allow read, write: if isSignedIn()`, so any signed-in user sees every
// client. This file is how we stop taking that on faith.
//
// Run:  cd tests && npm test
// (firebase emulators:exec starts a Firestore emulator around `node --test`)

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  collection,
  collectionGroup,
  query,
  where,
  getDocs,
  deleteDoc,
} from 'firebase/firestore';
import { readFileSync } from 'node:fs';

let testEnv;

const ALICE = 'uid_alice'; // member of project A
const BOB = 'uid_bob'; // member of project B
const CAROL = 'uid_carol'; // member of project A, but WITHOUT project.view
const ADMIN = 'uid_admin'; // platform admin
const PROJECT_A = 'proj_acme';
const PROJECT_B = 'proj_globex';

const FULL = [
  'project.view',
  'project.edit',
  'items.fetch',
  'items.analyze',
  'drafts.generate',
  'drafts.approve',
  'drafts.publish',
];

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'motherlink-engage-test',
    firestore: {
      rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });

  // Seed with rules disabled — this is fixture setup, not a test.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    await setDoc(doc(db, 'users', ALICE), { uid: ALICE, email: 'alice@x.io', role: 'member' });
    await setDoc(doc(db, 'users', BOB), { uid: BOB, email: 'bob@x.io', role: 'member' });
    await setDoc(doc(db, 'users', CAROL), { uid: CAROL, email: 'carol@x.io', role: 'member' });

    await setDoc(doc(db, 'projects', PROJECT_A), { name: 'Acme', enabledModules: ['reddit'] });
    await setDoc(doc(db, 'projects', PROJECT_B), { name: 'Globex', enabledModules: ['reddit'] });

    await setDoc(doc(db, 'projects', PROJECT_A, 'members', ALICE), { uid: ALICE, permissions: FULL });
    await setDoc(doc(db, 'projects', PROJECT_B, 'members', BOB), { uid: BOB, permissions: FULL });
    // Carol is a member of A but has no project.view.
    await setDoc(doc(db, 'projects', PROJECT_A, 'members', CAROL), {
      uid: CAROL,
      permissions: ['analytics.view'],
    });

    await setDoc(doc(db, 'projects', PROJECT_A, 'modules', 'reddit'), {
      targetSubreddits: ['budget'],
    });
    await setDoc(doc(db, 'projects', PROJECT_A, 'items', 'item_1'), {
      platform: 'reddit',
      title: 'acme post',
    });
    await setDoc(doc(db, 'projects', PROJECT_B, 'items', 'item_2'), {
      platform: 'reddit',
      title: 'globex post',
    });
    await setDoc(doc(db, 'projects', PROJECT_A, 'drafts', 'draft_1'), { body: 'hi', status: 'draft' });
    await setDoc(doc(db, 'projects', PROJECT_B, 'drafts', 'draft_2'), { body: 'yo', status: 'draft' });

    await setDoc(doc(db, 'accounts', 'acct_1'), { label: 'Growth', username: 'budgetlee_app' });
    await setDoc(doc(db, 'jobs', 'job_a'), { projectId: PROJECT_A, status: 'queued', body: 'x' });
    await setDoc(doc(db, 'jobs', 'job_b'), { projectId: PROJECT_B, status: 'queued', body: 'y' });
    await setDoc(doc(db, 'agents', 'agent'), { pid: 1 });
    await setDoc(doc(db, 'invitations', 'inv_1'), { email: 'new@x.io', token: 'secret-token' });
    await setDoc(doc(db, 'activity_logs', 'log_1'), { userId: ALICE, action: 'tool.opened' });
    await setDoc(doc(db, 'activity_logs', 'log_2'), { userId: BOB, action: 'tool.opened' });
  });
});

after(async () => {
  await testEnv?.cleanup();
});

const asAlice = () => testEnv.authenticatedContext(ALICE).firestore();
const asBob = () => testEnv.authenticatedContext(BOB).firestore();
const asCarol = () => testEnv.authenticatedContext(CAROL).firestore();
const asAdmin = () => testEnv.authenticatedContext(ADMIN, { role: 'admin' }).firestore();
const asAnon = () => testEnv.unauthenticatedContext().firestore();

// ---------------------------------------------------------------------------

describe('cross-project isolation — the claim the migration exists to make true', () => {
  test('Alice reads her own project', async () => {
    await assertSucceeds(getDoc(doc(asAlice(), 'projects', PROJECT_A)));
  });

  test("Alice CANNOT read Bob's project", async () => {
    await assertFails(getDoc(doc(asAlice(), 'projects', PROJECT_B)));
  });

  test("Alice CANNOT read Bob's project items", async () => {
    await assertFails(getDoc(doc(asAlice(), 'projects', PROJECT_B, 'items', 'item_2')));
  });

  test("Alice CANNOT read Bob's drafts", async () => {
    await assertFails(getDoc(doc(asAlice(), 'projects', PROJECT_B, 'drafts', 'draft_2')));
  });

  test("Alice CANNOT list Bob's items", async () => {
    await assertFails(getDocs(collection(asAlice(), 'projects', PROJECT_B, 'items')));
  });

  test("Bob CANNOT read Alice's project", async () => {
    await assertFails(getDoc(doc(asBob(), 'projects', PROJECT_A)));
  });

  test("Bob CANNOT read Alice's module config", async () => {
    await assertFails(getDoc(doc(asBob(), 'projects', PROJECT_A, 'modules', 'reddit')));
  });

  test('Alice reads her own items and drafts', async () => {
    await assertSucceeds(getDoc(doc(asAlice(), 'projects', PROJECT_A, 'items', 'item_1')));
    await assertSucceeds(getDoc(doc(asAlice(), 'projects', PROJECT_A, 'drafts', 'draft_1')));
  });

  test('Alice can LIST her own items/analyses/drafts — the client read path', async () => {
    // These are the queries the browser now runs directly instead of via the
    // server. If any of them failed, the review screen would hang.
    await assertSucceeds(getDocs(collection(asAlice(), 'projects', PROJECT_A, 'items')));
    await assertSucceeds(getDocs(collection(asAlice(), 'projects', PROJECT_A, 'analyses')));
    await assertSucceeds(getDocs(collection(asAlice(), 'projects', PROJECT_A, 'drafts')));
    await assertSucceeds(getDocs(collection(asAlice(), 'projects', PROJECT_A, 'sources')));
  });
});

describe('collection-group members read — powers the client "my projects" query', () => {
  test('Alice can query her own memberships across all projects', async () => {
    const q = query(collectionGroup(asAlice(), 'members'), where('uid', '==', ALICE));
    await assertSucceeds(getDocs(q));
  });

  test("Alice CANNOT query Bob's memberships via collection group", async () => {
    // The rule keys on the document id being the caller's uid, so filtering by
    // someone else's uid returns docs the rule forbids -> the query fails.
    const q = query(collectionGroup(asAlice(), 'members'), where('uid', '==', BOB));
    await assertFails(getDocs(q));
  });

  test('an unfiltered collection-group members scan is denied', async () => {
    await assertFails(getDocs(collectionGroup(asAlice(), 'members')));
  });
});

describe('permission granularity within a project', () => {
  test('Carol is a member but lacks project.view, so cannot read items', async () => {
    await assertFails(getDoc(doc(asCarol(), 'projects', PROJECT_A, 'items', 'item_1')));
  });

  test('Carol can still see the project itself and its member list', async () => {
    await assertSucceeds(getDoc(doc(asCarol(), 'projects', PROJECT_A)));
    await assertSucceeds(getDoc(doc(asCarol(), 'projects', PROJECT_A, 'members', ALICE)));
  });
});

describe('unauthenticated access — ML Studio allowed all of this', () => {
  test('anon cannot read projects', async () => {
    await assertFails(getDoc(doc(asAnon(), 'projects', PROJECT_A)));
  });

  test('anon cannot read items', async () => {
    await assertFails(getDoc(doc(asAnon(), 'projects', PROJECT_A, 'items', 'item_1')));
  });

  test('anon cannot read users', async () => {
    await assertFails(getDoc(doc(asAnon(), 'users', ALICE)));
  });

  test('anon cannot read accounts', async () => {
    await assertFails(getDoc(doc(asAnon(), 'accounts', 'acct_1')));
  });

  test('anon cannot read the job queue', async () => {
    await assertFails(getDoc(doc(asAnon(), 'jobs', 'job_a')));
  });

  test('anon CANNOT write a job — the ML Studio hole that let a stranger post from your accounts', async () => {
    await assertFails(
      setDoc(doc(asAnon(), 'jobs', 'evil'), { projectId: PROJECT_A, status: 'queued', body: 'spam' }),
    );
  });
});

describe('clients cannot write — every mutation goes through the server tier', () => {
  test('Alice cannot write to her own project', async () => {
    await assertFails(setDoc(doc(asAlice(), 'projects', PROJECT_A), { name: 'hacked' }));
  });

  test('Alice cannot create an item', async () => {
    await assertFails(setDoc(doc(asAlice(), 'projects', PROJECT_A, 'items', 'new'), { title: 'x' }));
  });

  test('Alice cannot enqueue a job directly, even for her own project', async () => {
    await assertFails(
      setDoc(doc(asAlice(), 'jobs', 'mine'), { projectId: PROJECT_A, status: 'queued', body: 'x' }),
    );
  });

  test('Alice cannot grant herself permissions', async () => {
    await assertFails(
      setDoc(doc(asAlice(), 'projects', PROJECT_A, 'members', ALICE), {
        uid: ALICE,
        permissions: [...FULL, 'project.members'],
      }),
    );
  });

  test('Alice cannot add herself to Bob\'s project', async () => {
    await assertFails(
      setDoc(doc(asAlice(), 'projects', PROJECT_B, 'members', ALICE), { uid: ALICE, permissions: FULL }),
    );
  });

  test('Alice cannot escalate her own global role', async () => {
    await assertFails(setDoc(doc(asAlice(), 'users', ALICE), { uid: ALICE, role: 'owner' }));
  });

  test('Alice cannot delete an account record', async () => {
    await assertFails(deleteDoc(doc(asAlice(), 'accounts', 'acct_1')));
  });

  test('even a platform admin cannot write from the client', async () => {
    await assertFails(setDoc(doc(asAdmin(), 'projects', PROJECT_A), { name: 'nope' }));
  });
});

describe('invitations are entirely server-side', () => {
  test('anon cannot read an invitation (ML Studio allowed this at limit 1)', async () => {
    await assertFails(getDoc(doc(asAnon(), 'invitations', 'inv_1')));
  });

  test('a signed-in user cannot enumerate invitations to harvest tokens', async () => {
    await assertFails(getDocs(collection(asAlice(), 'invitations')));
  });

  test('even a platform admin cannot read invitations from the client', async () => {
    await assertFails(getDoc(doc(asAdmin(), 'invitations', 'inv_1')));
  });
});

describe('platform admin', () => {
  test('admin reads any project', async () => {
    await assertSucceeds(getDoc(doc(asAdmin(), 'projects', PROJECT_A)));
    await assertSucceeds(getDoc(doc(asAdmin(), 'projects', PROJECT_B)));
  });

  test('admin reads any user', async () => {
    await assertSucceeds(getDoc(doc(asAdmin(), 'users', ALICE)));
  });

  test('a plain member cannot read another user profile', async () => {
    await assertFails(getDoc(doc(asAlice(), 'users', BOB)));
  });

  test('a user reads their own profile', async () => {
    await assertSucceeds(getDoc(doc(asAlice(), 'users', ALICE)));
  });
});

describe('scoped reads on shared collections', () => {
  test('Alice reads a job for her project', async () => {
    await assertSucceeds(getDoc(doc(asAlice(), 'jobs', 'job_a')));
  });

  test("Alice CANNOT read a job for Bob's project — draft bodies leak otherwise", async () => {
    await assertFails(getDoc(doc(asAlice(), 'jobs', 'job_b')));
  });

  test('any signed-in user reads accounts (no credentials stored there)', async () => {
    await assertSucceeds(getDoc(doc(asAlice(), 'accounts', 'acct_1')));
  });

  test('any signed-in user reads the agent heartbeat', async () => {
    await assertSucceeds(getDoc(doc(asAlice(), 'agents', 'agent')));
  });
});

describe('activity logs', () => {
  test('a user reads their own log entry', async () => {
    await assertSucceeds(getDoc(doc(asAlice(), 'activity_logs', 'log_1')));
  });

  test("a user cannot read someone else's log entry", async () => {
    await assertFails(getDoc(doc(asAlice(), 'activity_logs', 'log_2')));
  });

  test('admin reads any log entry', async () => {
    await assertSucceeds(getDoc(doc(asAdmin(), 'activity_logs', 'log_2')));
  });
});

describe('unnamed collections are denied by default', () => {
  test('a made-up collection is unreadable', async () => {
    await assertFails(getDoc(doc(asAlice(), 'something_new', 'x')));
  });

  test('a made-up collection is unwritable', async () => {
    await assertFails(setDoc(doc(asAlice(), 'something_new', 'x'), { a: 1 }));
  });
});
