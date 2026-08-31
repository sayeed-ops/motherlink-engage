// What a post is ABOUT — teams, the fixture, and the numbers it quotes.
//
// PURE. Text in, entities out. No model call: this is the cheap pass the plan
// asks for, and it is what makes the event clock, the asset match and the
// footprint view possible later.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY THIS IS RULES AND NOT A MODEL CALL
//
// Every harvested post would otherwise cost a model call before anything has
// decided the post is even worth reading — the exact inversion of the cost
// order the funnel is built on (free rejections, then paid reads, then model
// calls). Teams are a closed vocabulary and betting lines are a notation, so
// both are readable with rules. Intent is not, and stays in phase 3 where it is
// paid for once per SURVIVING post.
// ════════════════════════════════════════════════════════════════════════════

import { aliasIndex, hasLexicon, type AliasStrength } from './teams';

export interface QuotedLine {
  /**
   * `spread` — a small signed number, `Seattle -3.5`.
   * `total`  — `o47.5`, `under 2.5`.
   * `price`  — a three or four digit signed number.
   *
   * ⚠️ `price` IS DELIBERATELY NOT CALLED `moneyline`. `-110` is standard juice
   * on a spread; `+150` is a moneyline; `-140` could be either, and nothing in
   * the text distinguishes them. Naming the field for what it certainly is —
   * a price — rather than for what it usually is keeps a guess from hardening
   * into a stored fact. Phase 3 may narrow it with context; this pass will not.
   */
  kind: 'spread' | 'total' | 'price';
  /** Exactly as written, for showing a person what was read. */
  raw: string;
  value: number;
  /** The team the number is attached to, when one is adjacent. */
  teamKey: string | null;
  /** Totals only. */
  side: 'over' | 'under' | null;
  /** Character offset in the text it was read from. Kept because it is what
   *  makes "is this team next to this number" answerable — and because a person
   *  reading a post back can be shown where the number was. */
  at: number;
}

export interface Fixture {
  sport: string;
  /** `nfl:sea+sf` — sorted, so the same game yields the same key whoever is
   *  named first. This is the join key an event calendar would use. */
  key: string;
  teams: [string, string];
  /** Known ONLY from an explicit "at" or "@". `vs` does not settle it, and
   *  guessing would put the wrong team at home half the time. */
  home: string | null;
  away: string | null;
}

export interface CoversEntities {
  /** From the section registry — never guessed from the text. */
  sport: string | null;
  /** False when we do not know this league's teams at all. Distinguishes
   *  "nobody named a team" from "we cannot tell". See teams.ts. */
  lexicon: boolean;
  /** Canonical team keys, in the order first mentioned. */
  teams: string[];
  fixture: Fixture | null;
  lines: QuotedLine[];
}

export const NO_ENTITIES: CoversEntities = {
  sport: null,
  lexicon: false,
  teams: [],
  fixture: null,
  lines: [],
};

// ---------------------------------------------------------------------------
// Text scanning
// ---------------------------------------------------------------------------

interface Mention {
  key: string;
  strength: AliasStrength;
  start: number;
  end: number;
  /** Exactly as the writer typed it. Case is evidence — see `corroborated`. */
  raw: string;
}

/** Lowercased, same LENGTH as the input: every offset still points at the same
 *  character in the original text, so `raw` slices are the writer's own words. */
function normalise(text: string): string {
  return text.toLowerCase();
}

const patternCache = new Map<string, { key: string; strength: AliasStrength; re: RegExp }[]>();

function patternsFor(sport: string) {
  const hit = patternCache.get(sport);
  if (hit) return hit;

  const built = aliasIndex(sport).map(({ alias, key, strength }) => ({
    key,
    strength,
    // Words separated by anything non-alphanumeric: "st. louis", "st louis" and
    // "st-louis" are the same name written three ways.
    re: new RegExp(
      `(?<![a-z0-9])${alias.split(' ').map(escapeRe).join('[^a-z0-9]+')}(?![a-z0-9])`,
      'g',
    ),
  }));

  patternCache.set(sport, built);
  return built;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Team mentions, longest alias first and never overlapping.
 *
 * The alias index is sorted long-to-short and each match claims its span, so
 * "New York Giants" is read as the Giants rather than as New York (dropped as
 * ambiguous) plus Giants — and "Red Sox" never leaves a stray "Sox".
 */
function findMentions(text: string, sport: string): Mention[] {
  const lower = normalise(text);
  const taken: [number, number][] = [];
  const found: Mention[] = [];

  for (const { key, strength, re } of patternsFor(sport)) {
    re.lastIndex = 0;
    for (const m of lower.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      found.push({ key, strength, start, end, raw: text.slice(start, end) });
    }
  }

  return found.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

const TOTAL = /(?<![a-z0-9])(o|u|over|under)\s*(\d{1,3}(?:\.\d)?)(?![a-z0-9])/g;
/** Three or four digits: a price. Two or fewer: a spread. */
const PRICE = /(?<![\d.\-+])([-+]\d{3,4})(?![\d.])/g;
const SPREAD = /(?<![\d.\-+])([-+]\d{1,2}(?:\.\d)?)(?![\d.])/g;

/** How far from a number we will look for the team it belongs to. About the
 *  width of "the Seattle Seahawks " — far enough for a name, too short to reach
 *  the next selection on the next line. */
const ATTACH_CHARS = 24;

/** How close a number must be to VOUCH FOR an abbreviation. A space, a bracket,
 *  a colon — not a clause. */
const ADJACENT_CHARS = 3;

/** Characters between a mention and a line, whichever side it falls. */
function gapBetween(m: { start: number; end: number }, l: { at: number; raw: string }): number {
  return l.at >= m.end ? l.at - m.end : m.start - (l.at + l.raw.length);
}

function findLines(text: string, mentions: Mention[]): QuotedLine[] {
  const lower = normalise(text);
  const lines: QuotedLine[] = [];
  const taken: [number, number][] = [];

  const claim = (start: number, end: number): boolean => {
    if (taken.some(([s, e]) => start < e && end > s)) return false;
    taken.push([start, end]);
    return true;
  };

  for (const m of lower.matchAll(TOTAL)) {
    const start = m.index ?? 0;
    if (!claim(start, start + m[0].length)) continue;
    lines.push({
      kind: 'total',
      raw: text.slice(start, start + m[0].length).trim(),
      value: Number(m[2]),
      teamKey: null,
      side: m[1].startsWith('o') ? 'over' : 'under',
      at: start,
    });
  }

  // Prices before spreads: `-110` must not be read as a spread of minus one
  // hundred and ten.
  for (const [re, kind] of [
    [PRICE, 'price'],
    [SPREAD, 'spread'],
  ] as const) {
    for (const m of lower.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (!claim(start, end)) continue;
      lines.push({
        kind,
        raw: text.slice(start, end).trim(),
        value: Number(m[1]),
        teamKey: nearestTeam(mentions, start, end),
        side: null,
        at: start,
      });
    }
  }

  return lines.sort((a, b) => a.at - b.at);
}

/** The team a number is attached to: the one just before it ("Seattle -3.5")
 *  in preference to the one just after ("-3.5 Seahawks"), because that is the
 *  order bettors write. */
function nearestTeam(mentions: Mention[], start: number, end: number): string | null {
  const before = mentions.filter((t) => t.end <= start && start - t.end <= ATTACH_CHARS);
  if (before.length > 0) return before[before.length - 1].key;

  const after = mentions.find((t) => t.start >= end && t.start - end <= ATTACH_CHARS);
  return after?.key ?? null;
}

// ---------------------------------------------------------------------------
// Corroboration
// ---------------------------------------------------------------------------

/**
 * Which mentions survive.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AN ABBREVIATION IS BELIEVED WHEN IT IS WRITTEN LIKE ONE
 *
 * The two and three letter forms collide with ordinary English — NO (New
 * Orleans), WAS (Washington), AS, OS, MS, MIN, CAR, TB — and on a betting forum
 * every post contains a betting word, so "is this post about betting" is no test
 * at all. It was the first rule tried and the live run found it out inside three
 * threads: an announcement titled "Odds shark is joining covers" became a New
 * Orleans at Washington fixture, entirely out of the words "now" and "was".
 *
 * What actually separates the two is HOW IT IS WRITTEN, and bettors are
 * consistent about it:
 *
 *   accepted   `NO -3.5`      all caps — nobody shouts a preposition
 *              `Sea -3.5`     a betting number within a few characters
 *   rejected   `no chance`    lower case, no number near it
 *              `No idea`      capitalised only because a sentence started
 *
 * A strong mention — a nickname, or a city unique in its league — needs none of
 * this: "the Seahawks" in an NFL section is not plausibly about a bird.
 *
 * The failure this prevents is not cosmetic. A fixture is built from exactly two
 * teams, so one false "NO" turns a Seahawks thread into Seattle-at-New Orleans
 * and every join downstream is wrong about which game it is looking at.
 * ════════════════════════════════════════════════════════════════════════════
 */
function corroborated(mentions: Mention[], lines: QuotedLine[]): Mention[] {
  return mentions.filter((m) => {
    if (m.strength === 'strong') return true;

    // Written in caps, as a bettor writes a team code.
    if (m.raw === m.raw.toUpperCase() && /[A-Z]/.test(m.raw)) return true;

    // Or written directly against a number, which is what makes `Sea -3.5` a
    // selection and `sea` a noun.
    //
    // TOUCHING, not merely nearby. The attachment window used for deciding which
    // team a number belongs to is two dozen characters wide, and at that width
    // "no idea, took the over 44" reads as New Orleans — the number is 17
    // characters away and the sentence is ordinary English. A selection is
    // written with the number against the name, so the corroboration window is
    // the width of a space and a bracket.
    return lines.some((l) => gapBetween(m, l) <= ADJACENT_CHARS);
  });
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const AT_SEPARATOR = /(?<![a-z])(at|@|vs|v)(?![a-z])/gi;

/**
 * Two teams and only two make a fixture.
 *
 * A "Week 1 bets" thread names ten teams and is not a game; a thread naming one
 * team is about a team, not a match-up. Both return null rather than a guess,
 * and phase 3 can still use `teams` for either.
 */
function fixtureFrom(sport: string, mentions: Mention[], text: string): Fixture | null {
  const order: string[] = [];
  for (const m of mentions) if (!order.includes(m.key)) order.push(m.key);
  if (order.length !== 2) return null;

  const [first, second] = order;
  const firstAt = mentions.find((m) => m.key === first)!;
  const secondAt = mentions.find((m) => m.key === second)!;
  const between = normalise(text).slice(
    Math.min(firstAt.end, secondAt.end),
    Math.max(firstAt.start, secondAt.start),
  );

  // "A at B" — A travels. "A vs B" says only that they play; the home side is
  // written first as often as second, so it stays unknown.
  let home: string | null = null;
  let away: string | null = null;
  for (const m of between.matchAll(AT_SEPARATOR)) {
    const sep = m[1].toLowerCase();
    if (sep === 'at' || sep === '@') {
      away = firstAt.start < secondAt.start ? first : second;
      home = away === first ? second : first;
    }
    break;
  }

  const sorted = [...order].sort() as [string, string];
  return { sport, key: fixtureKey(sport, sorted), teams: sorted, home, away };
}

// ---------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------

/**
 * Entities in one piece of text — a post body, or a thread title.
 *
 * `sport` comes from the section registry, not from the text. A section IS a
 * league on Covers, and inferring "this mentions the Rangers so it must be
 * hockey" inside the MLB forum would be a worse answer than the one the URL
 * already gave us.
 */
export function extractEntities(text: string, sport: string | null): CoversEntities {
  if (!text.trim()) return { ...NO_ENTITIES, sport, lexicon: hasLexicon(sport) };

  if (!hasLexicon(sport)) {
    // No team vocabulary, but a quoted number is still a quoted number.
    return { sport, lexicon: false, teams: [], fixture: null, lines: findLines(text, []) };
  }

  const league = sport as string;
  const raw = findMentions(text, league);
  const lines = findLines(text, raw);
  const mentions = corroborated(raw, lines);

  // Lines were attached using every candidate mention; drop attachments to a
  // team the corroboration step then rejected, or a line would keep a team the
  // entity list does not admit to having seen.
  const kept = new Set(mentions.map((m) => m.key));
  const cleaned = lines.map((l) => (l.teamKey && !kept.has(l.teamKey) ? { ...l, teamKey: null } : l));

  const teams: string[] = [];
  for (const m of mentions) if (!teams.includes(m.key)) teams.push(m.key);

  return {
    sport: league,
    lexicon: true,
    teams,
    fixture: fixtureFrom(league, mentions, text),
    lines: cleaned,
  };
}

/**
 * Roll a thread's title and posts into one set of entities.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE FIRST PART IS AUTHORITATIVE ABOUT THE FIXTURE. NO OTHER PART VOTES.
 *
 * Callers pass the thread TITLE first, because a game thread is named for its
 * game. Everything after it is evidence about what the thread discusses, not
 * about what it is.
 *
 * The rule this replaced took the first fixture found anywhere, and the live run
 * showed what that costs: "Dk nfl preseason week 3" — a card of six games — was
 * filed under Baltimore-at-Washington because one post happened to name exactly
 * two teams. A card is not a game, and a thread confidently joined to the wrong
 * fixture is worse than one joined to none, because the second is visibly
 * unknown and the first is quietly false.
 *
 * So after the title, the only other way to a fixture is unanimity: the WHOLE
 * thread mentions exactly two teams. That cannot be produced by one stray post.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function mergeEntities(parts: readonly CoversEntities[]): CoversEntities {
  const sport = parts.find((p) => p.sport !== null)?.sport ?? null;
  const teams: string[] = [];
  const lines: QuotedLine[] = [];

  for (const p of parts) {
    for (const t of p.teams) if (!teams.includes(t)) teams.push(t);
    lines.push(...p.lines);
  }

  const sorted = [...teams].sort();
  const pairKey = sport && sorted.length === 2 ? fixtureKey(sport, sorted) : null;

  const fixture =
    parts[0]?.fixture ??
    (pairKey
      ? {
          sport: sport as string,
          key: pairKey,
          teams: sorted as [string, string],
          // Orientation only from a part that named this exact pairing with an
          // explicit "at". Two teams mentioned across five posts say nothing
          // about who is at home.
          home: parts.find((p) => p.fixture?.key === pairKey && p.fixture.home)?.fixture?.home ?? null,
          away: parts.find((p) => p.fixture?.key === pairKey && p.fixture.away)?.fixture?.away ?? null,
        }
      : null);

  return {
    sport,
    lexicon: parts.some((p) => p.lexicon),
    teams,
    fixture,
    lines,
  };
}

/** `nfl:sea+sf` from sorted canonical keys. One definition, so the key a thread
 *  is stored under is the key a post's fixture produces. */
function fixtureKey(sport: string, sortedTeamKeys: readonly string[]): string {
  return `${sport}:${sortedTeamKeys.map((k) => k.split(':')[1]).join('+')}`;
}

// ---------------------------------------------------------------------------
// Kickoff
// ---------------------------------------------------------------------------

/**
 * ════════════════════════════════════════════════════════════════════════════
 * KICKOFF IS NOT KNOWN IN V1, AND SAYS SO
 *
 * The plan wants thread → fixture → kickoff, because age against kickoff is the
 * freshness signal on a betting forum: a thread about Sunday's game is live on
 * Saturday and worthless on Monday. Two of the three legs are done here — a
 * thread now yields a stable fixture key. The third needs a schedule, and there
 * is NO odds or schedule feed in V1 (a stated decision, not an oversight) and no
 * web search in this stack.
 *
 * So kickoff is `null` with a reason, never a guess derived from the post's own
 * date. The seam is this interface — a calendar is one implementation of it, in
 * the same way SourceFinder is the seam for web search in the interview. Phase 3
 * reads `kickoffMs === null` as "unknown", which its screens must handle
 * anyway for every thread in a section we have no lexicon for.
 * ════════════════════════════════════════════════════════════════════════════
 */
export interface FixtureCalendar {
  kickoffFor(fixture: Fixture, nearMs: number): Promise<number | null>;
}

export const NO_CALENDAR: FixtureCalendar = {
  async kickoffFor() {
    return null;
  },
};
