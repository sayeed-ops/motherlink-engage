// A scan record, in plain English.
//
// The pipeline writes its trace in its own shorthand — "room: 5 winners, 43
// words median, band 25–164", "gates: 3 of 3 could be posted" — which is exact
// and was written for whoever built it. The comment karma panel shows these
// lines to the person reviewing the comment, who needs the same facts in words
// that explain themselves.
//
// TRANSLATED AT DISPLAY, NOT AT WRITE. The trace on a stored record stays
// exactly what the pipeline wrote (it is evidence, and the learning code and
// the tests read it), and every record ever filed — not just new ones — reads
// the plain way. A line this does not recognise is shown as it was written,
// so a new kind of line can never disappear from the panel.
//
// PURE — the panel imports it, and so do the tests.

import type { SkipStage } from './drafts';

export const WANT_LABEL: Record<string, string> = {
  information: 'an answer or facts',
  opinions: 'people’s opinions',
  comfort: 'support',
  entertainment: 'to be entertained',
  decision: 'help deciding',
  vent: 'to vent — not advice',
};

export const GAP_STATE_LABEL: Record<string, string> = {
  absent: 'nobody has said the useful thing yet',
  'said-badly': 'someone said it, but not clearly',
  buried: 'someone said it, but it sits at the bottom with no votes',
  partial: 'the answers are there but miss a detail that makes them usable',
  none: 'it has already been said well, at the top',
};

/** The same, in two or three words — for a label rather than a sentence. */
export const GAP_STATE_SHORT: Record<string, string> = {
  absent: 'not said yet',
  'said-badly': 'said, but unclearly',
  buried: 'said, but buried',
  partial: 'said, missing a detail',
  none: 'already said well',
};

/** Why a post was passed over when it was opened. */
export const REJECT_LABEL: Record<string, string> = {
  media: 'it is an image or video post',
  'link-post': 'it is a link to somewhere else',
  'nothing-to-answer': 'it has no text and the title asks nothing',
  locked: 'comments are locked',
  archived: 'it is archived',
  stickied: 'it is pinned by the moderators',
  nsfw: 'it is marked NSFW',
  'too-young': 'it is too new to tell whether anyone will see it',
  'too-old': 'it is old enough that new comments are not seen',
  crowded: 'it has so many comments a new one would be lost',
  unbeatable: 'the top comment is too far ahead to compete with',
  contested: 'the votes say people are already arguing',
  'not-rising': 'it is getting less attention than usual for this subreddit',
  'contest-mode': 'comments are shown in random order, so there is no top spot',
  quarantined: 'the subreddit is quarantined',
  removed: 'it has been removed',
  'score-hidden': 'its scores are hidden, so its reach cannot be judged',
};

/** Why a written comment was refused by the automatic checks. */
export const CHECK_LABEL: Record<string, string> = {
  empty: 'nothing was written',
  'too-short': 'too short for this thread',
  'too-long': 'too long for this thread',
  'first-line-too-long': 'its first sentence is too long',
  'banned-opener': 'it opens with a phrase people recognise as AI',
  'banned-closer': 'it ends with a phrase people recognise as AI',
  'assistant-tell': 'it sounds like an AI assistant',
  meta: 'it talks about the thread instead of to it',
  link: 'it contains a link',
  brand: 'it names a brand',
  formatting: 'it uses bullets or headings in a thread that writes plain text',
  'appeal-to-authority': 'it quotes a source we cannot back up',
  'unverifiable-statistic': 'it states a number as fact',
  duplicate: 'it repeats a comment already there',
  'opening-repeat': 'it opens the way this account opened a recent comment',
  'length-uniform': 'it is the same length as this account’s recent comments',
  'all-considered': 'every recent comment from this account is a long, careful one',
  'cadence-regular': 'this account has been commenting at too regular intervals',
  'clock-narrow': 'this account always comments at the same time of day',
  'sub-monotony': 'this account comments in one subreddit only',
};

const STAGE_LABEL: Record<SkipStage, string> = {
  timing: 'not now, to keep the account’s rhythm natural',
  search: 'nothing recent to comment on',
  screen: 'no post worth opening',
  judge: 'no thread worth joining',
  gap: 'nothing worth adding',
  generate: 'nothing usable was written',
  gates: 'everything written failed the automatic checks',
  critic: 'none of the drafts was good enough',
  'final-gates': 'the chosen draft failed a final check',
  error: 'it could not run',
};

const FEED_LABEL: Record<string, string> = { hot: 'Hot', new: 'New', rising: 'Rising', top: 'Top' };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "40m" → "40 minutes", "3052m" → "51 hours". */
function minutes(m: number): string {
  return m < 120 ? plural(m, 'minute') : plural(Math.round(m / 60), 'hour');
}

const reasonLabel = (code: string) => REJECT_LABEL[code] ?? code;

/** One trace line, said plainly. Unknown lines come back as written. */
export function explainTraceLine(line: string): string {
  const s = line.trim();
  let m: RegExpMatchArray | null;

  if ((m = s.match(/^feed r\/(\S+) \/(\w+)$/))) {
    return `Opened r/${m[1]}, sorted by ${FEED_LABEL[m[2]] ?? m[2]}.`;
  }
  if ((m = s.match(/^(\d+) post\(s\) in the feed$/))) return `${plural(Number(m[1]), 'post')} there.`;
  if ((m = s.match(/^pace: median post here is ([\d.]+)h old → window (\d+)m–(\d+)h$/))) {
    return `A typical post here is ${m[1]} hours old, so it looked for posts between ${minutes(Number(m[2]))} and ${plural(Number(m[3]), 'hour')} old.`;
  }
  if ((m = s.match(/^age window: (\d+) of (\d+) in range$/))) {
    return `${m[1]} of the ${m[2]} posts were the right age.`;
  }
  if ((m = s.match(/^search r\/(\S+) "(.*)"$/))) return `Searched r/${m[1]} for “${m[2]}”.`;
  if ((m = s.match(/^(\d+) result\(s\)$/))) return `${plural(Number(m[1]), 'result')}.`;
  if ((m = s.match(/^screen: (\d+) of (\d+) survived$/))) {
    return `${m[1]} of ${m[2]} passed a first look, before opening any of them.`;
  }
  if (s.startsWith('exploring:')) {
    return 'This scan was allowed to take a thread the scorer would normally pass over, to test the rules.';
  }
  if ((m = s.match(/^read (\w+): ok \(score ([\d.]+)\)$/))) {
    return `Opened post ${m[1]} — a good thread to join (fit score ${m[2]}; higher is better).`;
  }
  if ((m = s.match(/^read (\w+): rejected — (.+)$/))) return `Opened post ${m[1]} — passed over: ${reasonLabel(m[2])}.`;
  if ((m = s.match(/^read (\w+): gone since the listing$/))) return `Post ${m[1]} was deleted before it could be opened.`;
  if ((m = s.match(/^taking it anyway \(testing: ignoring "(.+)"\)$/))) {
    return `Took it anyway — a testing switch overrides “${reasonLabel(m[1])}”.`;
  }
  if ((m = s.match(/^taking it anyway \(exploring past "(.+)"\)$/))) {
    return `Took it anyway, to test the rule “${reasonLabel(m[1])}”.`;
  }
  if ((m = s.match(/^room: (\d+) winners, (\d+) words median, band (\d+)–(\d+)$/))) {
    const n = Number(m[1]);
    const measured = n
      ? `Read the thread’s comments: ${plural(n, 'well-upvoted comment')}, typically ${m[2]} words long`
      : 'Read the thread’s comments: none well-upvoted yet';
    return `${measured}, so the comment should be ${m[3]}–${m[4]} words.`;
  }
  if (s.startsWith('gap: refused, and ignored (testing)')) {
    return 'The AI found nothing worth adding, but a testing switch made it write something anyway — expect filler.';
  }
  if ((m = s.match(/^gap: ([\w-]+) at ([\d.]+), below the learned floor of ([\d.]+)$/))) {
    return `The AI’s idea (${GAP_STATE_LABEL[m[1]] ?? m[1]}) was ${pct(m[2])} sure — this account needs ${pct(m[3])}.`;
  }
  if ((m = s.match(/^gap: ([\w-]+) \(confidence ([\d.]+)\)$/))) {
    return `What the thread is missing: ${GAP_STATE_LABEL[m[1]] ?? m[1]} (${pct(m[2])} sure).`;
  }
  if (s === 'gap: unparseable') return 'The AI’s answer about what the thread is missing could not be read.';
  if ((m = s.match(/^gap: (\w+) \/ ([\w-]+) — ([\s\S]+)$/))) {
    return `The poster wants ${WANT_LABEL[m[1]] ?? m[1]}; so far ${GAP_STATE_LABEL[m[2]] ?? m[2]}. The angle: ${m[3]}`;
  }
  if ((m = s.match(/^seen before: (\d+) thread\(s\) skipped$/))) {
    return `Skipped ${plural(Number(m[1]), 'thread')} an earlier scan already looked at.`;
  }
  if ((m = s.match(/^wrote (\d+) candidate\(s\)$/))) return `Wrote ${plural(Number(m[1]), 'draft comment')}.`;
  if ((m = s.match(/^gates: (\d+) of (\d+) could be posted$/))) {
    return `${m[1]} of ${m[2]} drafts passed the automatic checks (length, tone, AI-sounding phrases, links, repeats).`;
  }
  if (s === 'critic: chose none, and that was ignored (testing)') {
    return 'The reviewing AI liked none of them; a testing switch picked one anyway.';
  }
  if ((m = s.match(/^critic: none — ([\s\S]+)$/))) return `The reviewing AI liked none of them: ${m[1]}`;
  if (s === 'final gates: failed') return 'The chosen draft failed the automatic checks on a second look.';
  if ((m = s.match(/^chose a (\d+)-word comment — ([\s\S]+)$/))) return `Picked a ${m[1]}-word comment. Why: ${m[2]}`;
  if ((m = s.match(/^stop: ([\w-]+) — ([\s\S]+)$/))) {
    return `Stopped — ${STAGE_LABEL[m[1] as SkipStage] ?? m[1]}: ${m[2]}`;
  }
  if ((m = s.match(/^skipped r\/(\S+): ([\s\S]+)$/))) return `Skipped r/${m[1]}: ${m[2]}`;
  if ((m = s.match(/^error: ([\s\S]+)$/))) return `Could not run: ${m[1]}`;
  return line;
}

/** 0.7 → "70%". */
function pct(raw: string | number): string {
  const n = Number(raw);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : String(raw);
}

export const confidenceLabel = pct;
