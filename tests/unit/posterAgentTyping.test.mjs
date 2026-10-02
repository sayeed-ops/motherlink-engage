// "Does the box hold the reply" and how a reply is broken into typing units.
//
// Policy, not just units:
//   - a dropped LETTER or PUNCTUATION mark is a different reply;
//   - what editors legitimately do (paragraph shape, markdown escapes, curly
//     quotes, dashes) is not;
//   - a focus check can sit between every word.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstDifference, normaliseTyped, sameText, typingUnits } from '../../apps/poster-agent/typing.mjs';
import * as plan from '../../apps/poster-agent/shopify/plan.mjs';

const reply = 'The mistake wasn’t tone.\n\nIt was pitching the *wrong* person — twice.';

test('what editors do to a reply does not count as a change', () => {
  assert.ok(sameText(reply, "The mistake wasn't tone.\n\nIt was pitching the \\*wrong\\* person - twice.\n"), 'markdown textarea');
  assert.ok(sameText(reply, "The mistake wasn't tone.\nIt was pitching the *wrong* person — twice."), 'rich editor');
  assert.ok(sameText('a b', 'a b'));
});

test('a dropped letter, word or punctuation mark IS a change', () => {
  assert.ok(!sameText(reply, reply.replace('pitching', 'pitchng')), 'dropped letter');
  assert.ok(!sameText(reply, reply.replace('the *wrong* ', '')), 'dropped words');
  assert.ok(!sameText(reply, reply.replace('tone.', 'tone')), 'dropped full stop');
  assert.ok(!sameText('Yes, it works', 'Yes it works'), 'dropped comma');
  assert.ok(!sameText('', ''), 'an empty reply never matches');
});

test('the first difference says where and what', () => {
  assert.equal(firstDifference('abc', 'abc'), null);
  const d = firstDifference('pitching the one writer', 'pitchng the one writer');
  assert.equal(d.at, 5);
  assert.equal(d.expected.slice(0, 3), 'ing');
  assert.equal(d.got.slice(0, 3), 'ng ');
  assert.equal(normaliseTyped(' x  y '), 'x y');
});

test('typing units: a word at a time, with the paragraph break the editor needs', () => {
  const md = typingUnits('Hi there.\n\nSecond line\nthird', 2);
  assert.deepEqual(md, [
    { text: 'Hi ' }, { text: 'there.' },
    { key: 'Enter', times: 2 },
    { text: 'Second ' }, { text: 'line' },
    { key: 'Enter', shift: true, times: 1 },
    { text: 'third' },
  ]);
  assert.equal(typingUnits('a\n\nb', 1).find((u) => u.key).times, 1, 'rich editor: one Enter per paragraph');
  assert.equal(typingUnits('one two three').map((u) => u.text).join(''), 'one two three', 'units rebuild the text');
});

test('the old word-only comparison is gone from the Shopify plan', () => {
  assert.equal(plan.typedMatches, undefined);
  assert.equal(plan.wordsOf, undefined);
});
