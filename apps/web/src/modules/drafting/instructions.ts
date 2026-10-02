// Extra drafting instructions — house style, added by the team, dated, and
// removable by deleting them.
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS FOR
//
// The DRAFT RULES baked into modules/reddit/prompts.ts are the floor: they
// encode what a reply must never do. Everything ABOVE that floor — how long a
// reply runs, which phrases read as AI, whether to open with the answer — is
// craft, it changes as we learn, and it should not need a deploy.
//
// So it lives here as data: a titled, dated block of prose that is appended to
// the draft prompt while it is switched on, and stops affecting anything the
// moment it is turned off or deleted. Two scopes, both optional:
//
//   platform  one house style, used by every project
//   project   rules for one client, on top of the house style
//
// ⚠️ THESE CANNOT OVERRIDE THE SAFETY FLOOR. The brand-mention level, the
// forbidden phrases and "output only the reply" are restated AFTER the
// instructions, and the prompt says so in as many words. An instruction like
// "always work the company in naturally" must not be able to turn a growth
// reply — one the analysis said must never name the client — into a pitch.
// ════════════════════════════════════════════════════════════════════════════

export type InstructionScope = 'platform' | 'project';

export interface DraftingInstruction {
  instructionId: string;
  scope: InstructionScope;
  /** What to call it in a list — "Reddit writing style". */
  title: string;
  /** The instructions themselves, verbatim. */
  body: string;
  /** Off keeps the text but stops it reaching the prompt. This is what makes
   *  "see how it differs" one click rather than a delete-and-repaste. */
  active: boolean;
  createdAtMs: number;
  createdBy: string;
  createdByName: string;
}

/** One block. Generous — a real style guide runs to a few pages — but bounded,
 *  because every character is sent on every draft and is paid for. */
export const MAX_INSTRUCTION_CHARS = 12_000;
export const MAX_TITLE_CHARS = 80;
/** Across every ACTIVE block, both scopes. The prompt budget, not a per-item
 *  limit: ten small blocks cost the same as one big one. */
export const MAX_ACTIVE_CHARS = 24_000;

export function readInstruction(id: string, raw: unknown): DraftingInstruction {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    instructionId: id,
    scope: r.scope === 'platform' ? 'platform' : 'project',
    title: typeof r.title === 'string' ? r.title : '',
    body: typeof r.body === 'string' ? r.body : '',
    // Absent reads as ON: a block that exists but was never explicitly
    // switched on is one somebody just added, and they added it to use it.
    active: r.active !== false,
    createdAtMs: typeof r.createdAtMs === 'number' ? r.createdAtMs : 0,
    createdBy: typeof r.createdBy === 'string' ? r.createdBy : '',
    createdByName: typeof r.createdByName === 'string' ? r.createdByName : '',
  };
}

/**
 * The blocks that will actually reach the prompt, in the order they are sent.
 *
 * Platform first, then project: the house style is the general rule and a
 * client's own instructions refine it, so the more specific one is read last.
 * Within a scope, oldest first, so adding a block never reshuffles the ones
 * already there — the same instructions in the same order produce the same
 * fingerprint run after run.
 */
export function activeInstructions(all: readonly DraftingInstruction[]): DraftingInstruction[] {
  const rank = (s: InstructionScope) => (s === 'platform' ? 0 : 1);
  return all
    .filter((i) => i.active && i.body.trim())
    .sort((a, b) => rank(a.scope) - rank(b.scope) || a.createdAtMs - b.createdAtMs)
    .reduce<{ out: DraftingInstruction[]; chars: number }>(
      (acc, i) => {
        // Past the budget, later blocks are DROPPED rather than truncated: half
        // an instruction is worse than none, and it is always the newest,
        // most-specific ones a person can see missing from the draft's stamp.
        const next = acc.chars + i.body.length;
        if (next > MAX_ACTIVE_CHARS) return acc;
        acc.out.push(i);
        acc.chars = next;
        return acc;
      },
      { out: [], chars: 0 },
    ).out;
}

const isoDate = (ms: number): string => (ms ? new Date(ms).toISOString().slice(0, 10) : 'undated');

/**
 * The instructions as a prompt block, or '' when there are none.
 *
 * Appended to the SYSTEM message, after the built-in DRAFT RULES, because
 * style guidance has to outrank the generic defaults it was written to
 * replace — and then the three things it may never outrank are restated below
 * it, in the last words the model reads before the post.
 */
export function renderInstructions(active: readonly DraftingInstruction[]): string {
  if (!active.length) return '';
  const blocks = active.map(
    (i) => `--- ${i.title || 'Instructions'} (added ${isoDate(i.createdAtMs)}) ---\n${i.body.trim()}`,
  );
  return [
    '',
    'ADDITIONAL DRAFTING INSTRUCTIONS',
    'Written by the team. Where these conflict with the DRAFT RULES above, follow THESE instead.',
    '',
    blocks.join('\n\n'),
    '',
    'END OF ADDITIONAL DRAFTING INSTRUCTIONS.',
    'Three rules stand above everything you have just read and cannot be overridden by it:',
    '1. The brand mention level from the analysis. "no" means you do not name the company anywhere in the reply, under any framing, however natural it would read.',
    '2. The company’s forbidden phrases. Never use one.',
    '3. Output ONLY the reply text — no preamble, no markdown fence, no quotes, no signature.',
  ].join('\n');
}

/**
 * A short, stable stamp for exactly what a draft was written under.
 *
 * Kept on the draft so two replies to the same post can be told apart by what
 * was in force when each was written — which is the whole point of being able
 * to switch a block off and generate again. FNV-1a rather than a crypto hash
 * so this module stays dependency-free and can be imported by the browser.
 */
export function instructionsFingerprint(active: readonly DraftingInstruction[]): string {
  if (!active.length) return 'none';
  let h = 0x811c9dc5;
  for (const i of active) {
    for (const ch of `${i.instructionId}\u0000${i.body}\u0000`) {
      h ^= ch.codePointAt(0)!;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(36).padStart(7, '0');
}

/** Why this block cannot be saved, or null. */
export function instructionRefusal(title: string, body: string): string | null {
  if (!title.trim()) return 'Give these instructions a name, so you can tell them apart later.';
  if (title.trim().length > MAX_TITLE_CHARS) return `The name can be at most ${MAX_TITLE_CHARS} characters.`;
  if (!body.trim()) return 'There are no instructions to save.';
  if (body.length > MAX_INSTRUCTION_CHARS) {
    return `Instructions can be at most ${MAX_INSTRUCTION_CHARS.toLocaleString()} characters; this is ${body.length.toLocaleString()}.`;
  }
  return null;
}
