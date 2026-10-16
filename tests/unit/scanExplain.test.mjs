// The comment karma panel says what a scan did in plain words, and keeps the
// post a comment answers. These pin the translations against the exact lines
// the pipeline writes — a reworded trace line must not silently fall back to
// shorthand in the panel.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { explainTraceLine, confidenceLabel } from '../../apps/web/src/modules/forum/reply/explain.ts';

const cases = [
  ['feed r/apartmentliving /hot', 'Opened r/apartmentliving, sorted by Hot.'],
  ['  25 post(s) in the feed', '25 posts there.'],
  ['pace: median post here is 13.2h old → window 40m–16h', 'A typical post here is 13.2 hours old, so it looked for posts between 40 minutes and 16 hours old.'],
  ['pace: median post here is 1017.3h old → window 3052m–24h', 'A typical post here is 1017.3 hours old, so it looked for posts between 51 hours and 24 hours old.'],
  ['age window: 16 of 25 in range', '16 of the 25 posts were the right age.'],
  ['read 1x78kw4: rejected — media', 'Opened post 1x78kw4 — passed over: it is an image or video post.'],
  ['read 1x6uws9: ok (score 0.98)', 'Opened post 1x6uws9 — a good thread to join (fit score 0.98; higher is better).'],
  ['room: 5 winners, 43 words median, band 25–164', 'Read the thread’s comments: 5 well-upvoted comments, typically 43 words long, so the comment should be 25–164 words.'],
  ['room: 0 winners, 0 words median, band 2–13', 'Read the thread’s comments: none well-upvoted yet, so the comment should be 2–13 words.'],
  ['wrote 3 candidate(s)', 'Wrote 3 draft comments.'],
  ['  taking it anyway (testing: ignoring "score-hidden")', 'Took it anyway — a testing switch overrides “its scores are hidden, so its reach cannot be judged”.'],
  ['stop: gates — Every candidate failed a check.', 'Stopped — everything written failed the automatic checks: Every candidate failed a check.'],
  ['error: terminated', 'Could not run: terminated'],
];

test('each kind of trace line reads plainly', () => {
  for (const [line, want] of cases) assert.equal(explainTraceLine(line), want);
});

test('the gap and the choice keep their substance', () => {
  assert.match(
    explainTraceLine('gap: information / partial — The missing qualifier is the motor.'),
    /^The poster wants an answer or facts; so far the answers are there but miss a detail that makes them usable\. The angle: The missing qualifier is the motor\.$/,
  );
  assert.match(explainTraceLine('gates: 3 of 3 could be posted'), /^3 of 3 drafts passed the automatic checks/);
  assert.equal(explainTraceLine('chose a 50-word comment — It answers it.'), 'Picked a 50-word comment. Why: It answers it.');
});

test('a line it does not know is shown exactly as written', () => {
  assert.equal(explainTraceLine('something new: 7 things'), 'something new: 7 things');
});

test('confidence reads as a percentage', () => {
  assert.equal(confidenceLabel(0.7), '70%');
});
