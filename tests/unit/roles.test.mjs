// Platform roles and what they imply.
//
// `tester` exists to sit between member and admin: it may create its own
// scratch projects and must NOT reach the posting identities. Both halves of
// that sentence are load-bearing, and both are one edited line away from being
// silently wrong — globalPermissions is derived from role, so a mistake here
// grants warm-up to everyone who tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GLOBAL_ROLES,
  GLOBAL_ROLE_PERMISSIONS,
  globalPermissionsForRole,
  PERMISSION_BUNDLES,
  PERMISSIONS,
  builtInRoles,
} from '../../apps/web/src/lib/types.ts';

// --- the point of the tester role ------------------------------------------

test('tester may create projects', () => {
  assert.ok(globalPermissionsForRole('tester').includes('projects.create'));
});

test('tester may NOT manage accounts — no warm-up, no posting identities', () => {
  assert.ok(!globalPermissionsForRole('tester').includes('accounts.manage'));
});

test('member has no platform powers at all', () => {
  assert.deepEqual(globalPermissionsForRole('member'), []);
});

test('owner and admin keep everything they had', () => {
  for (const role of ['owner', 'admin']) {
    const held = globalPermissionsForRole(role);
    assert.ok(held.includes('accounts.manage'), `${role} lost accounts.manage`);
    assert.ok(held.includes('projects.create'), `${role} lost projects.create`);
  }
});

test('every declared role has a permission row', () => {
  for (const role of GLOBAL_ROLES) {
    assert.ok(role in GLOBAL_ROLE_PERMISSIONS, `${role} has no GLOBAL_ROLE_PERMISSIONS entry`);
  }
});

test('globalPermissionsForRole returns a copy, not the shared array', () => {
  const held = globalPermissionsForRole('tester');
  held.push('accounts.manage');
  assert.ok(
    !globalPermissionsForRole('tester').includes('accounts.manage'),
    'mutating a returned array leaked into the source of truth',
  );
});

// --- the tester project bundle ---------------------------------------------

test('the tester bundle cannot publish — the irreversible step', () => {
  assert.ok(!PERMISSION_BUNDLES.tester.includes('drafts.publish'));
});

test('the tester bundle cannot train the model — test edits are not training data', () => {
  assert.ok(!PERMISSION_BUNDLES.tester.includes('drafts.train'));
});

test('the tester bundle holds everything else, so new permissions are opt-OUT', () => {
  const missing = PERMISSIONS.filter(
    (p) => p !== 'drafts.publish' && p !== 'drafts.train' && !PERMISSION_BUNDLES.tester.includes(p),
  );
  assert.deepEqual(missing, [], `tester is missing: ${missing.join(', ')}`);
});

test('approving is allowed — it is reversible, unlike publishing', () => {
  assert.ok(PERMISSION_BUNDLES.tester.includes('drafts.approve'));
});

// --- the pickers pick it up ------------------------------------------------

test('tester appears in the project role picker with a description', () => {
  const tester = builtInRoles().find((r) => r.id === 'tester');
  assert.ok(tester, 'tester is not in builtInRoles()');
  assert.equal(tester.builtIn, true);
  assert.ok(tester.description.length > 0, 'tester would render with an empty description');
});

test('no built-in role is left without help text', () => {
  for (const r of builtInRoles()) {
    assert.ok(r.description.length > 0, `${r.id} has no description`);
  }
});
