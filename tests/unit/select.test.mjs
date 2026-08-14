// Which credential runs a call — the ordering rule, tested directly.
//
// select.ts was split out of resolve.ts precisely so this file could exist:
// plain arrays in, a choice out, no Firestore. It decides whose money pays for
// every AI call in the product, so the cases below are deliberately about the
// ways it could be WRONG rather than the happy path.
//
// Two gates guard the shared key and they are independent:
//   grantedToProject  — may this CLIENT'S work bill this key?
//   mayUseShared      — is this PERSON trusted with org spend at all?

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseCredential, grantedToProject } from '../../apps/web/src/server/llm/select.ts';

const REF = 'deepseek:deepseek-chat';
const OTHER_REF = 'deepseek:deepseek-reasoner';

/** A shared org key, granted to `projects` (or every project). */
const sharedKey = (over = {}) => ({
  credentialId: 'shared-1',
  provider: 'deepseek',
  scope: 'shared',
  status: 'active',
  allowedModels: [REF],
  grantedProjectIds: ['proj-a'],
  grantAllProjects: false,
  ...over,
});

/** A key the caller added themselves. */
const personalKey = (over = {}) => ({
  credentialId: 'personal-1',
  provider: 'deepseek',
  scope: 'personal',
  status: 'active',
  allowedModels: [REF],
  ...over,
});

const choose = (over = {}) =>
  chooseCredential({
    shared: [],
    personal: [],
    projectId: 'proj-a',
    provider: 'deepseek',
    ref: REF,
    mayUseShared: true,
    ...over,
  });

// --- the ordering rule -----------------------------------------------------

test('a shared key granted to this project wins', () => {
  const pick = choose({ shared: [sharedKey()], personal: [personalKey()] });
  assert.equal(pick.source, 'project');
  assert.equal(pick.credential.credentialId, 'shared-1');
});

test('a personal key is the fallback when no grant covers the project', () => {
  const pick = choose({
    shared: [sharedKey({ grantedProjectIds: ['proj-b'] })],
    personal: [personalKey()],
  });
  assert.equal(pick.source, 'personal');
});

test('nothing is chosen when neither source has the model', () => {
  const pick = choose({ shared: [], personal: [] });
  assert.equal(pick.credential, null);
  assert.equal(pick.source, null);
});

// --- the per-person entitlement --------------------------------------------

test('a granted shared key is NOT used by someone denied org spend', () => {
  const pick = choose({ shared: [sharedKey()], personal: [], mayUseShared: false });
  assert.equal(pick.credential, null, 'org key must not be spent by a denied caller');
  assert.equal(pick.source, null);
});

test('a denied caller falls through to their own key', () => {
  const pick = choose({ shared: [sharedKey()], personal: [personalKey()], mayUseShared: false });
  assert.equal(pick.source, 'personal');
  assert.equal(pick.credential.credentialId, 'personal-1');
});

test('denying one person does not disturb an entitled one', () => {
  const args = { shared: [sharedKey()], personal: [] };
  assert.equal(choose({ ...args, mayUseShared: true }).source, 'project');
  assert.equal(choose({ ...args, mayUseShared: false }).source, null);
});

// A denied caller must not be told to go and re-check a key they can neither
// use nor see — sawKeyWithoutModel is what picks that error message.
test('a denied caller does not inherit the "your key lacks this model" error', () => {
  const keyWithoutModel = sharedKey({ allowedModels: [OTHER_REF] });

  const entitled = choose({ shared: [keyWithoutModel], personal: [] });
  assert.equal(entitled.sawKeyWithoutModel, true, 'entitled: the key is real but lacks the model');

  const denied = choose({ shared: [keyWithoutModel], personal: [], mayUseShared: false });
  assert.equal(denied.sawKeyWithoutModel, false, 'denied: that key is not theirs to re-check');
});

test('a denied caller still gets the lacks-model error for their OWN key', () => {
  const pick = choose({
    shared: [],
    personal: [personalKey({ allowedModels: [OTHER_REF] })],
    mayUseShared: false,
  });
  assert.equal(pick.sawKeyWithoutModel, true);
});

// --- account-scoped work (no project) --------------------------------------

test('only an all-projects key applies when there is no project', () => {
  assert.equal(choose({ shared: [sharedKey()], projectId: null }).source, null);
  assert.equal(
    choose({ shared: [sharedKey({ grantAllProjects: true })], projectId: null }).source,
    'project',
  );
});

test('an all-projects key is still blocked by the per-person entitlement', () => {
  const pick = choose({
    shared: [sharedKey({ grantAllProjects: true })],
    projectId: null,
    mayUseShared: false,
  });
  assert.equal(pick.credential, null);
});

// --- status and provider filtering -----------------------------------------

test('inactive keys are ignored on both paths', () => {
  assert.equal(choose({ shared: [sharedKey({ status: 'disabled' })] }).source, null);
  assert.equal(choose({ personal: [personalKey({ status: 'invalid' })] }).source, null);
});

test('a key for a different provider never matches', () => {
  const pick = choose({
    shared: [sharedKey({ provider: 'openrouter' })],
    personal: [personalKey({ provider: 'openrouter' })],
  });
  assert.equal(pick.credential, null);
  assert.equal(pick.sawKeyWithoutModel, false);
});

// --- grantedToProject, used by the models endpoint too ---------------------

test('grantedToProject holds the grant rule on its own', () => {
  assert.equal(grantedToProject(sharedKey(), 'proj-a'), true);
  assert.equal(grantedToProject(sharedKey(), 'proj-b'), false);
  assert.equal(grantedToProject(sharedKey(), null), false);
  assert.equal(grantedToProject(sharedKey({ grantAllProjects: true }), null), true);
  assert.equal(grantedToProject(sharedKey({ status: 'disabled' }), 'proj-a'), false);
  assert.equal(grantedToProject(personalKey(), 'proj-a'), false, 'a personal key is never a grant');
});
