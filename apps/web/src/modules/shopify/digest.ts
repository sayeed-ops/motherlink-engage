// What the replies in a thread already say.
//
// PURE. Produced by the DRAFT call, in the same JSON as the reply — the
// replies are read once, by the call that needs them to write something better
// than what is there, and this is that call's account of what it read.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY IT IS NOT ITS OWN STEP ANY MORE
//
// It used to be stage two: every picked thread had its replies read and
// summarised, drafted or not, and a draft then sent the same replies again.
// The operator's design moved the reading of replies to the moment a reply is
// asked for. Producing this summary in the same call costs a few hundred output
// tokens and nothing else, and it keeps what the old reading was for: a person
// can see what the reply was measured against — "here is what you would be
// talking over" — before they copy it.
//
// `alreadySaid` and `whatIsMissing` stay separate fields. The first is the bar
// (Open) or the blocklist (Growth, Brand); the second is the opening.
// ════════════════════════════════════════════════════════════════════════════

export const ENGAGEMENT_SHAPES = [
  'unanswered', // asked, nobody has replied
  'answered-well', // solved, and the thread knows it
  'competing-answers', // several views, no agreement
  'thin-answers', // replies exist but none of them actually answer it
  'discussion', // not a question — people comparing notes
  'off-topic', // drifted, or never was about the subject
] as const;
export type EngagementShape = (typeof ENGAGEMENT_SHAPES)[number];

export const ENGAGEMENT_LABEL: Record<EngagementShape, string> = {
  unanswered: 'Asked, nobody answered',
  'answered-well': 'Answered, and the thread agrees',
  'competing-answers': 'Several answers, no agreement',
  'thin-answers': 'Replies that do not answer it',
  discussion: 'People comparing notes',
  'off-topic': 'Drifted off the subject',
};

/** One thing somebody put forward as an answer. */
export interface OfferedSolution {
  /** The approach in a few words — "add structured data". */
  approach: string;
  byUsername: string;
  postNumber: number;
  /** Accepted answer, or clearly agreed with. */
  endorsed: boolean;
}

export interface ThreadDigest {
  engagement: EngagementShape;
  offered: OfferedSolution[];
  /** The points made often enough that saying them again adds nothing. */
  alreadySaid: string[];
  /** What nobody has said that would genuinely help. */
  whatIsMissing: string;
}

export const EMPTY_DIGEST: ThreadDigest = {
  engagement: 'unanswered',
  offered: [],
  alreadySaid: [],
  whatIsMissing: '',
};

const str = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

/**
 * The `thread` object from a draft reply → a digest.
 *
 * Lenient where the old reading was strict, deliberately: the reading WAS the
 * product of its call, so an unparseable one had to be refused. Here the
 * product is the reply, and a digest the model skimped on must not throw the
 * reply away with it.
 */
export function parseDigest(v: unknown): ThreadDigest {
  const r = (v ?? {}) as Record<string, unknown>;
  const engagement = (ENGAGEMENT_SHAPES as readonly string[]).includes(String(r.engagement))
    ? (r.engagement as EngagementShape)
    : 'discussion';

  const offered: OfferedSolution[] = Array.isArray(r.offered)
    ? r.offered
        .map((o) => {
          const s = (o ?? {}) as Record<string, unknown>;
          const approach = str(s.approach, 200);
          if (!approach) return null;
          const n = Number(s.postNumber);
          return {
            approach,
            byUsername: str(s.byUsername, 60) || 'unknown',
            postNumber: Number.isInteger(n) && n > 0 ? n : 0,
            endorsed: s.endorsed === true,
          };
        })
        .filter((o): o is OfferedSolution => o !== null)
        .slice(0, 12)
    : [];

  return {
    engagement,
    offered,
    alreadySaid: Array.isArray(r.alreadySaid) ? r.alreadySaid.map((s) => str(s, 200)).filter(Boolean).slice(0, 12) : [],
    whatIsMissing: str(r.whatIsMissing, 600),
  };
}

/**
 * Would a reply here be repeating the thread?
 *
 * Free arithmetic over the digest. Shown as a warning on Growth and Brand;
 * never a gate on Open, whose whole posture is that repeating is fine when the
 * reply is better.
 */
export function wouldRepeat(d: ThreadDigest): boolean {
  return d.engagement === 'answered-well' && d.whatIsMissing.length === 0;
}
