// The autopilot's final pick: ONE comment out of the versions written for
// several different threads.
//
// PURE — prompt and parser, like ./critic.ts.
//
// Autopilot only. A person running "Look for a comment" still gets the critic's
// one-thread choice and approves it themselves; the autopilot, posting with no
// one watching, instead writes for five threads and lets this call choose the
// best comment AND the best thread at once (operator-approved after trials on
// 2026-10-26). It must choose: "none" was the critic's job, and with the testing
// switches on it collapsed to "post version 1" anyway.
//
// Labels are "thread.candidate" ("3.2") and the model answers with one label.
// The first trial asked for the two numbers separately and the model wrote the
// thread as "3.3" — a run with a good choice and no pick.

import type { ThreadSnapshot } from '../reader/types';
import type { CommentPersona } from './generate';

export interface PickOption {
  thread: ThreadSnapshot;
  /** The versions that passed the checks, in the order they were written. */
  versions: string[];
}

export interface PickResult {
  /** 0-based indexes into the options and that option's versions. */
  option: number;
  version: number;
  reason: string;
  ranking: string[];
}

/** How many of a thread's top replies the picker is shown. */
export const PICK_REPLIES = 5;

function trim(s: string, max: number): string {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function who(persona: CommentPersona): string {
  const situation = persona.situation?.trim();
  if (!situation && !persona.topics?.length) return 'This account has no stated background, job or family.';
  const parts = [`This account is: ${situation || '(no situation given)'}`];
  if (persona.topics?.length) parts.push(`it knows about ${persona.topics.join(', ')}`);
  if (persona.neverClaims?.length) parts.push(`it must never claim to be ${persona.neverClaims.join(', ')}`);
  return `${parts.join('; ')}.`;
}

export function pickSystem(persona: CommentPersona): string {
  return `You are choosing ONE Reddit comment to post, from comments written for several different threads. You are NOT writing or editing anything.

For each thread you see the original post, its top replies, and the candidate comments written for it.

${who(persona)}

Choose the single comment that is:
1. Most relevant to ITS OWN thread — it responds to what this poster actually wrote and wants, not a generic remark that would fit anywhere.
2. Most like a real person in that community wrote it — natural, specific, the length and tone of the replies there; nothing that reads as performed helpfulness or as written by an AI.
3. The least risky — no claim it could not defend; no personal experience, job, family or expertise this account has not been given; nothing that starts an argument; no advice to someone who did not ask for it; nothing that repeats what a top reply already said.

You must choose exactly one. Do not rewrite, combine or edit.

Every candidate has a label like "3.2" (thread 3, candidate 2). Answer with that label exactly as shown.

Output STRICT JSON: {"choice": "<label, e.g. 3.2>", "reason": "<two sentences: why this one, and what made the others worse>", "ranking": ["<label>", ... best to worst, all of them]}. No prose, no markdown.`;
}

export function buildPickPrompt(options: PickOption[], persona: CommentPersona): { system: string; user: string } {
  const user = options
    .map((o, i) => {
      const { post, comments } = o.thread;
      return [
        `=== THREAD ${i + 1} — r/${post.subreddit} ===`,
        `TITLE: ${trim(post.title, 300)}`,
        post.body.trim() ? `BODY: ${trim(post.body, 1200)}` : 'BODY: (none — the title is the whole post)',
        'TOP REPLIES:',
        comments.length
          ? comments
              .slice(0, PICK_REPLIES)
              .map((c, k) => `[${k + 1}] score=${c.score}: ${trim(c.body, 300)}`)
              .join('\n')
          : '(no replies yet)',
        'CANDIDATES:',
        ...o.versions.map((t, k) => `(${i + 1}.${k + 1}) ${t}`),
      ].join('\n');
    })
    .join('\n\n');
  return { system: pickSystem(persona), user: `${user}\n\nRespond with JSON only.` };
}

/** "3.2", "(3.2)", or the older {thread, candidate} shape → 1-based [thread, candidate]. */
export function parseChoiceLabel(raw: unknown): [number, number] | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fromLabel = (v: unknown): [number, number] | null => {
    const m = String(v ?? '').match(/(\d+)\s*\.\s*(\d+)/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  if (o.choice !== undefined) return fromLabel(o.choice);
  // The thread is the FIRST number of whatever was written ("3.3" → 3), and a
  // separate candidate number wins over anything after the dot.
  const th = Number(String(o.thread ?? '').match(/\d+/)?.[0]);
  const c = Number(o.candidate);
  if (Number.isInteger(th) && Number.isInteger(c)) return [th, c];
  return fromLabel(o.thread);
}

/** Never throws. A label outside the options is no pick — posting a comment
 *  nobody chose would be worse than posting nothing. */
export function parsePick(raw: unknown, options: PickOption[]): PickResult | null {
  const label = parseChoiceLabel(raw);
  if (!label) return null;
  const [t, c] = label;
  const opt = options[t - 1];
  if (!opt || !opt.versions[c - 1]) return null;
  const o = raw as Record<string, unknown>;
  return {
    option: t - 1,
    version: c - 1,
    reason: typeof o.reason === 'string' ? o.reason.trim() : '',
    ranking: Array.isArray(o.ranking) ? o.ranking.map(String) : [],
  };
}
