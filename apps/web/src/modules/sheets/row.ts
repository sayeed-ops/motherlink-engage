// One row of the tracking sheet: what goes in each column, and how the two
// platforms' analyses are turned into prose a person can read.
//
// ════════════════════════════════════════════════════════════════════════════
// THE ROW IS COMPOSED AT ENQUEUE TIME AND WRITTEN AFTER THE POST SUCCEEDS.
//
// Everything here runs when the reply is queued, and the result is frozen onto
// the job. The agent appends it only once the comment is actually up, and adds
// the three things only posting can know: the date, the permalink, and the
// Mention ID it claimed.
//
// Composing early is what makes the "Content Description" column trustworthy.
// It is a copy of the analysis THIS reply was written from. Rebuilding it after
// the fact would read whatever analysis exists by then — and a thread can be
// re-analysed ("think about it differently") between queueing and posting, so
// that is a different opinion than the one the reply answers.
// ════════════════════════════════════════════════════════════════════════════

import type { RedditOpportunityAnalysis } from '@/modules/reddit/types';
import type { Assessment } from '@/modules/shopify/assess';
import type { ReplyMode } from '@/modules/shopify/reply';

/**
 * The header row, in order.
 *
 * ⚠️ MIRRORED IN apps/poster-agent/sheets.mjs, which is what actually writes.
 * The agent is plain Node and cannot import TypeScript, so the list exists
 * twice; tests/unit/sheets.test.mjs reads both files and fails if they
 * ever drift. Change one, change the other.
 *
 * The first eight are the columns the sheet already had. The last two are new:
 * without them a row says what we thought about a thread but not what the
 * thread said, so nothing in it can be checked months later.
 */
export const SHEET_COLUMNS = [
  'Month',
  'Mention ID',
  'Date Posted',
  'Post Type',
  'Board/Subreddit',
  'Content Description',
  'Content URL',
  'Comment/Text',
  'Original Post Title',
  'Original Post Body',
] as const;

/**
 * Google's own limit is 50,000 characters per cell. These sit well under it,
 * because the point of the cell is to be read in a spreadsheet: past a few
 * thousand characters a person opens the thread instead.
 */
export const MAX_DESCRIPTION_CHARS = 4000;
export const MAX_BODY_CHARS = 8000;

/** Everything about a row that is known before the reply is posted. */
export interface SheetRowPayload {
  platform: 'reddit' | 'shopify';
  /**
   * Whether this reply may name the client.
   *
   * 'brand' is Reddit's yes/soft mention recommendation and Shopify's Brand
   * mode. 'growth' is everything else — Reddit's "no", and BOTH of Shopify's
   * non-brand modes (Open and Growth), which the sheet does not distinguish
   * because the only question it asks is "does this name the client?".
   *
   * Frozen with the rest of the payload; the FILTER that reads it is not — see
   * syncsKind in ../sheets/config.ts.
   */
  kind: 'brand' | 'growth';
  /** "Comment" — a column the sheet already has, for when posts join replies. */
  postType: string;
  /** Where it was posted: "r/gambling", or the Shopify board's name. */
  board: string;
  /** The analysis, as prose. See describeReddit / describeShopify. */
  contentDescription: string;
  originalTitle: string;
  originalBody: string;
  /** The reply itself, exactly as it was queued. */
  commentText: string;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Trim to a limit, saying so rather than stopping mid-word without a mark. */
export function clamp(text: string, max: number): string {
  const s = String(text ?? '').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** The parts of a date the sheet shows, in the posting machine's own timezone.
 *  Passing `timeZone` is for tests; live it is whatever the posting Mac is set
 *  to, which is the timezone the operator thinks in. */
export function datePosted(ms: number, timeZone?: string): { month: string; date: string } {
  const d = new Date(ms);
  const parts = timeZone
    ? new Intl.DateTimeFormat('en-US', { timeZone, year: '2-digit', month: 'numeric', day: 'numeric' })
        .formatToParts(d)
        .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {})
    : {
        month: String(d.getMonth() + 1),
        day: String(d.getDate()),
        year: String(d.getFullYear() % 100).padStart(2, '0'),
      };
  const monthIndex = Number(parts.month) - 1;
  return {
    month: MONTHS[monthIndex] ?? '',
    // Matches what the sheet already holds: 11/18/25.
    date: `${parts.month}/${parts.day}/${parts.year}`,
  };
}

const line = (label: string, value: unknown): string | null => {
  const v = String(value ?? '').trim();
  return v ? `${label}: ${v}` : null;
};

/**
 * A Reddit analysis, as the sheet's Content Description.
 *
 * Both axes are reported, not just the one the draft used. "Skip on brand, 70
 * on growth" is the whole reason a reply exists in some threads, and a
 * description that showed only the brand verdict would make the row look like a
 * mistake.
 */
export function describeReddit(a: Pick<
  RedditOpportunityAnalysis,
  'decision' | 'score' | 'reason' | 'suggestedAngle' | 'riskLevel' | 'mentionRecommendation' | 'growthScore' | 'growthAngle'
>): string {
  const mention =
    a.mentionRecommendation === 'yes' ? 'name the client' :
    a.mentionRecommendation === 'soft' ? 'name the client only if it fits' :
    'do not name the client';

  const out = [
    line('Verdict', `${a.decision} — ${a.score}/100 on brand fit`),
    line('Why', a.reason),
    line('Angle', a.suggestedAngle),
    typeof a.growthScore === 'number' ? line('Growth', `${a.growthScore}/100${a.growthAngle ? ` — ${a.growthAngle}` : ''}`) : null,
    line('Risk', `${a.riskLevel} · ${mention}`),
  ].filter((l): l is string => l !== null);

  return clamp(out.join('\n'), MAX_DESCRIPTION_CHARS);
}

/**
 * A Shopify Community analysis, as the sheet's Content Description.
 *
 * The mode that was actually drafted leads, because that is what the reply in
 * the next column is doing. The other two modes' scores follow on one line —
 * enough to see that Brand scored 2 and Growth 8, which is why this is a Growth
 * reply, without reprinting three paragraphs of reasoning.
 */
export function describeShopify(a: Assessment, mode: ReplyMode): string {
  const chosen = a.scores[mode];
  const others = (['open', 'growth', 'brand'] as const)
    .filter((m) => m !== mode)
    .map((m) => `${m} ${a.scores[m]?.score ?? 0}/10`)
    .join(', ');

  const out = [
    line('Reply', `${mode} — scored ${chosen?.score ?? 0}/10 (${others})`),
    line('Question', a.question),
    line('Asker', a.askerContext),
    line('Why this mode', chosen?.why),
    line('Angle', chosen?.angle),
    line('What a good answer needs', a.needs),
    line('Model suggested', `${a.suggested} · confidence ${a.confidence}`),
  ].filter((l): l is string => l !== null);

  return clamp(out.join('\n'), MAX_DESCRIPTION_CHARS);
}

/** Bound every free-text field once, in one place, before it is stored. */
export function boundPayload(p: SheetRowPayload): SheetRowPayload {
  return {
    platform: p.platform,
    kind: p.kind,
    postType: clamp(p.postType, 40) || 'Comment',
    board: clamp(p.board, 120),
    contentDescription: clamp(p.contentDescription, MAX_DESCRIPTION_CHARS),
    originalTitle: clamp(p.originalTitle, 500),
    originalBody: clamp(p.originalBody, MAX_BODY_CHARS),
    commentText: clamp(p.commentText, MAX_BODY_CHARS),
  };
}
