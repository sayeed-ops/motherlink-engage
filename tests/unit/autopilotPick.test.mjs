// The autopilot's final pick across threads — prompt and parser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPickPrompt, parseChoiceLabel, parsePick, pickSystem } from '../../apps/web/src/modules/forum/reply/autopilotPick.ts';

const thread = (sub, title, comments = []) => ({ post: { subreddit: sub, title, body: '' }, comments, fetchedAtMs: 0 });
const OPTIONS = [
  { thread: thread('moving', 'Truck size?', [{ score: 9, body: 'go 15ft' }]), versions: ['a', 'b'] },
  { thread: thread('learnmath', 'X% of?'), versions: ['c', 'd', 'e'] },
];

test('every answer shape the model has given reads as the right label', () => {
  assert.deepEqual(parseChoiceLabel({ choice: '2.3' }), [2, 3]);
  assert.deepEqual(parseChoiceLabel({ choice: '(1.2)' }), [1, 2]);
  assert.deepEqual(parseChoiceLabel({ thread: '3.3', candidate: 2 }), [3, 2]); // the trial's answer
  assert.deepEqual(parseChoiceLabel({ thread: 2, candidate: 1 }), [2, 1]);
  assert.equal(parseChoiceLabel({ choice: 'none' }), null);
  assert.equal(parseChoiceLabel(null), null);
});

test('a pick outside the options is no pick; a valid one maps to 0-based indexes', () => {
  assert.equal(parsePick({ choice: '3.1' }, OPTIONS), null);
  assert.equal(parsePick({ choice: '1.3' }, OPTIONS), null);
  assert.deepEqual(parsePick({ choice: '2.2', reason: ' why ', ranking: ['2.2', '1.1'] }, OPTIONS), { option: 1, version: 1, reason: 'why', ranking: ['2.2', '1.1'] });
});

test('the prompt labels every version and shows each thread with its replies', () => {
  const { user } = buildPickPrompt(OPTIONS, { topics: [], situation: '', neverClaims: [] });
  for (const label of ['(1.1) a', '(1.2) b', '(2.1) c', '(2.3) e']) assert.ok(user.includes(label), label);
  assert.ok(user.includes('THREAD 2 — r/learnmath') && user.includes('[1] score=9: go 15ft') && user.includes('(no replies yet)'));
});

test('the account background shapes the risk rule', () => {
  assert.match(pickSystem({ topics: [], situation: '', neverClaims: [] }), /no stated background/);
  assert.match(pickSystem({ topics: ['cycling'], situation: 'renting in Leeds', neverClaims: ['a doctor'] }), /renting in Leeds; it knows about cycling; it must never claim to be a doctor/);
});
