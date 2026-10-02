// The module registry, and the invariant that used to be a manual habit.
//
// Adding a module used to mean three separate edits: the `Platform` union, a
// nav entry, and the enabled allowlist. Shopify Community shipped with the nav
// entry and without the allowlist, so the project page rendered an Enable
// button that answered "Not available yet: shopify".
//
// Every test missed it — including a browser run — because they all reached the
// module by its own URL and never went through the project page, which is the
// one route a person actually takes. These assertions are the structural
// version of that lesson.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MODULES, ENABLED_PLATFORMS, PLATFORMS } from '../../apps/web/src/lib/types.ts';

test('every module with a screen can be enabled', () => {
  // THE BUG, PINNED. A module the project page offers an Open link for must be
  // one the API will accept in enabledModules, or the card is a dead end.
  for (const m of MODULES.filter((m) => m.path !== null)) {
    assert.ok(
      ENABLED_PLATFORMS.includes(m.id),
      `"${m.name}" has a screen at /${m.path} but is not in ENABLED_PLATFORMS — its Enable button will fail`,
    );
  }
});

test('nothing without a screen is enable-able', () => {
  // The converse. Enabling a module with nothing behind it gives somebody a
  // card that opens onto a 404.
  for (const m of MODULES.filter((m) => m.path === null)) {
    assert.ok(!ENABLED_PLATFORMS.includes(m.id), `"${m.name}" is enable-able but has no screen`);
  }
});

test('every module id is a real Platform', () => {
  for (const m of MODULES) {
    assert.ok(PLATFORMS.includes(m.id), `"${m.id}" is not in the Platform union`);
  }
});

test('every Platform has exactly one module entry', () => {
  // A platform with no entry is invisible on the project page; a duplicate
  // renders twice and the second Enable undoes the first.
  for (const p of PLATFORMS) {
    const found = MODULES.filter((m) => m.id === p);
    assert.equal(found.length, 1, `${p} has ${found.length} module entries, expected exactly 1`);
  }
});

test('paths are unique, and are route segments rather than URLs', () => {
  const paths = MODULES.map((m) => m.path).filter((p) => p !== null);
  assert.equal(new Set(paths).size, paths.length, 'two modules share a path');
  for (const p of paths) {
    assert.ok(!p.startsWith('/'), `"${p}" is absolute; it is joined onto /projects/:id/`);
    assert.ok(!p.includes('://'), `"${p}" looks like a URL`);
  }
});

test('every module says what it is', () => {
  for (const m of MODULES) {
    assert.ok(m.name.trim().length > 0, `${m.id} has no name`);
    assert.ok(m.blurb.trim().length > 0, `${m.id} has no blurb`);
  }
});

test('the reading modules are present and the unbuilt ones are honest', () => {
  const byId = Object.fromEntries(MODULES.map((m) => [m.id, m]));
  assert.equal(byId.shopify.path, 'shopify');
  assert.equal(byId.covers.path, 'covers');
  assert.equal(byId.reddit.path, 'reddit');
  assert.equal(byId.quora.path, null);
  assert.equal(byId.linkedin.path, null);
});
