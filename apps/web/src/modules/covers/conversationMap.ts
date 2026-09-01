// What this forum's audience actually talks about — independent of any client.
//
// PURE. Clustering is arithmetic over analyses we already paid for; the one
// model call that names and describes each need lives in the server layer, and
// this file builds its prompt and parses its answer.
//
// ════════════════════════════════════════════════════════════════════════════
// THIS IS PLATFORM INTELLIGENCE, NOT CLIENT INTELLIGENCE
//
// The distinction is the whole architecture of the bootstrap, and it decides
// where this data lives and what a reset may delete:
//
//   CONVERSATION MAP     what Covers bettors need          about the FORUM
//         ↕
//     MATCHMAKER
//         ↕
//   ASSETS / CLAIMS      what this client can offer        about the CLIENT
//
// A map describes the audience. Swapping the client changes nothing about it.
// So resetting client knowledge must NOT delete it — otherwise rebuilding the
// map after every client change means re-running triage, which is the expensive
// half of the pipeline, to relearn something the client never affected.
//
// It is also why the map is STORED rather than computed on demand from
// `analyses`: the reset clears analyses, and the observation about the forum has
// to outlive the pipeline output it was derived from.
// ════════════════════════════════════════════════════════════════════════════
//
// ════════════════════════════════════════════════════════════════════════════
// AND IT IS NOT THE GAP BOARD
//
// `buildGaps` answers "what do people ask that this client cannot answer" — it
// reads only `no-asset-match` posts, so it is a finding about the LIBRARY and it
// is empty when the library is good. This reads EVERY post the classifier could
// make sense of, matched or not, because "what does this audience need" has the
// same answer whether or not we happen to have an asset for it.
//
// Building the map from gaps alone would mean a client with good coverage sees
// an empty map and concludes the forum has no needs.
// ════════════════════════════════════════════════════════════════════════════

import { tokenise } from '@/modules/knowledge/retrieval';
import type { PostIntent } from './intent';

// ---------------------------------------------------------------------------
// What goes in
// ---------------------------------------------------------------------------

/** One triaged post, reduced to what the map reads. Deliberately a structural
 *  type rather than `StoredTriage` — the map has no business knowing about
 *  variants, eligibility or scores. */
export interface MapInput {
  postId: string;
  itemId: string;
  section: string;
  outcome: string;
  intent: {
    intent: PostIntent;
    problem: string;
    concepts: string[];
    asksSomething: boolean;
  } | null;
}

/**
 * Outcomes whose posts describe a real need.
 *
 * `opportunity` and `no-asset-match` are the two that reached the classifier and
 * had something to answer — the first is covered demand, the second uncovered,
 * and the map wants both. `complaint` is excluded for the same reason it leaves
 * the marketing pipeline: an angry customer is a support event, and mining it
 * for "needs" is how a system decides that people want to be sold to while they
 * are furious.
 */
const MAPPABLE_OUTCOMES = new Set(['opportunity', 'no-asset-match']);

/** Posts that count as demand. Same rule the gap board applies, for the same
 *  reason: without it the map measures what the forum TALKS about, which is
 *  football, rather than what it NEEDS. */
export function isMappable(row: MapInput): boolean {
  if (!row.intent) return false;
  if (!MAPPABLE_OUTCOMES.has(row.outcome)) return false;
  if (!row.intent.asksSomething) return false;
  if (row.intent.intent === 'pick-sharing') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/** A concept and the posts that raised it, before a model names anything. */
export interface RawCluster {
  /** The concept phrases that merged into this cluster, commonest first. */
  concepts: string[];
  posts: number;
  threads: number;
  sections: string[];
  /** Verbatim problem statements. The evidence a person reads to check the
   *  cluster is real rather than a coincidence of vocabulary. */
  examples: string[];
  intents: Partial<Record<PostIntent, number>>;
}

/**
 * How many content tokens two concepts must share to be the same need.
 *
 * "sgm tracking" and "tracking sgm legs" are one need; "deposit bonus" and
 * "deposit limit" are two. Set at "every token of the shorter appears in the
 * longer", which is strict enough that unrelated concepts sharing one ordinary
 * word do not merge, and loose enough that word order and padding do not split
 * a need in half.
 */
function sameNeed(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const set = new Set(long);
  return short.every((t) => set.has(t));
}

/**
 * Group the concepts people actually used into candidate needs.
 *
 * ⚠️ COUNTED BY THREAD AS WELL AS BY POST. Twenty replies inside one argument
 * is one conversation, not twenty pieces of demand — the lesson the gap board
 * already learned. A cluster that is loud in one thread and absent everywhere
 * else is a thread, not a need.
 */
export function clusterConcepts(rows: readonly MapInput[]): RawCluster[] {
  interface Bucket {
    tokens: string[];
    counts: Map<string, number>;
    posts: Set<string>;
    threads: Set<string>;
    sections: Set<string>;
    /** ⚠️ PAIRED WITH THE CONCEPT THAT PRODUCED THEM. One post raises several
     *  concepts and therefore lands in several buckets, so an example taken
     *  from "any post in this bucket" routinely illustrates a different need
     *  than the one it is printed under — the first live map showed "line
     *  movement" evidenced by a post about a missing prop. Keeping the concept
     *  lets the output prefer examples from the bucket's OWN main concept. */
    examples: { concept: string; problem: string }[];
    intents: Map<PostIntent, number>;
  }

  const buckets: Bucket[] = [];

  for (const row of rows) {
    if (!isMappable(row)) continue;
    const intent = row.intent!;

    for (const concept of intent.concepts) {
      const tokens = tokenise(concept);
      if (tokens.length === 0) continue;

      let bucket = buckets.find((b) => sameNeed(b.tokens, tokens));
      if (!bucket) {
        bucket = {
          tokens,
          counts: new Map(),
          posts: new Set(),
          threads: new Set(),
          sections: new Set(),
          examples: [],
          intents: new Map(),
        };
        buckets.push(bucket);
      }

      // The shortest spelling wins as the bucket's key: it is the one most
      // likely to appear again, and merging is by containment.
      if (tokens.length < bucket.tokens.length) bucket.tokens = tokens;

      bucket.counts.set(concept, (bucket.counts.get(concept) ?? 0) + 1);
      bucket.posts.add(row.postId);
      bucket.threads.add(row.itemId);
      bucket.sections.add(row.section);
      bucket.intents.set(intent.intent, (bucket.intents.get(intent.intent) ?? 0) + 1);

      if (
        bucket.examples.length < 12 &&
        intent.problem &&
        !bucket.examples.some((e) => e.problem === intent.problem)
      ) {
        bucket.examples.push({ concept, problem: intent.problem });
      }
    }
  }

  return buckets
    .map((b) => {
      const concepts = [...b.counts.entries()].sort((x, y) => y[1] - x[1]).map(([c]) => c);
      const top = new Set(concepts.slice(0, 3));

      return {
        concepts,
        posts: b.posts.size,
        threads: b.threads.size,
        sections: [...b.sections],
        // Examples raised BY this cluster's main concepts first. A post that
        // landed here on a peripheral concept still illustrates something, but
        // it should not be the line a person reads under the heading.
        examples: b.examples
          .sort((x, y) => Number(top.has(y.concept)) - Number(top.has(x.concept)))
          .map((e) => e.problem),
        intents: Object.fromEntries(b.intents) as Partial<Record<PostIntent, number>>,
      };
    })
    .sort((a, b) => b.threads - a.threads || b.posts - a.posts);
}

/**
 * Clusters thin enough that naming them would be inventing a need.
 *
 * ⚠️ ONE POST IS NOT A RECURRING NEED. The operator's instruction was explicit:
 * six credible needs beat twelve manufactured ones. A cluster has to recur —
 * either across threads, or enough times within the sample to be more than one
 * person having one thought.
 */
export const MIN_THREADS = 3;
export const MIN_POSTS = 4;

/**
 * ⚠️ RAISED AFTER THE FIRST WIDE RUN, DELIBERATELY. At two threads the map
 * returned fifteen needs and several were the same need wearing a different
 * brand name — "DraftKings account limits" and "Bookmaker card and account
 * limits" are one question about whether books limit winners. A map padded to
 * its ceiling stops being evidence, and the instruction was explicit: six
 * credible needs beat twelve artificial ones.
 */
export function isRecurring(c: RawCluster): boolean {
  return c.threads >= MIN_THREADS || c.posts >= MIN_POSTS;
}

// ---------------------------------------------------------------------------
// The named need
// ---------------------------------------------------------------------------

/** `projects/{projectId}/coversNeeds/{needId}` — one recurring audience need. */
export interface CoversNeed {
  needId: string;
  /** Short human name: "Tracking multi-leg bets". */
  title: string;
  /** What people are trying to DO, one sentence, in their terms. */
  whatPeopleWant: string;
  /** The phrases the forum actually uses. These become retrieval triggers when
   *  a client capability is matched to this need, so they are the forum's words
   *  and never ours. */
  phrases: string[];
  /** Kinds of thing a client could offer here — "trackers", "documentation".
   *  A CATEGORY, not a product: naming products is the research step's job. */
  valueAreas: string[];

  // --- the evidence, so a person can check the need is real ---------------
  posts: number;
  threads: number;
  sections: string[];
  examples: string[];
  concepts: string[];
}

export const MAP_PROMPT_VERSION = 'covers-map-v1';

export const MAP_SYSTEM = `You are reading clusters of real posts from a sports betting forum and naming what the people writing them NEED.

You are NOT looking for anything to sell, and there is no client. You are describing an audience.

For each cluster you are given: the phrases people used, how many posts and threads it spans, and verbatim one-line summaries of what individual writers wanted.

For each, return:
- "title": a short human name for the need. "Tracking multi-leg bets", not "SGM".
- "whatPeopleWant": one sentence saying what they are trying to DO, in their terms.
- "phrases": 3-8 phrases FROM THE MATERIAL that signal this need in a thread.
- "valueAreas": 2-4 CATEGORIES of thing that could help — "bet trackers", "cashout documentation", "odds comparison". Categories, not company names, not products. You do not know who the client is and must not guess.

Rules:
- Describe only what the material supports. If a cluster is thin or incoherent, say so by returning it with an empty "title" and it will be dropped.
- Do not merge clusters and do not invent needs that span them.
- Do not use the word "our" or name any company, book or brand.
- Plain language. A person who has never used this tool should understand each line.

Output STRICT JSON: {"needs": [{"index": <the cluster number you were given>, "title": "…", "whatPeopleWant": "…", "phrases": ["…"], "valueAreas": ["…"]}]}
No prose outside the JSON.`;

function clip(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export function buildMapPrompt(clusters: readonly RawCluster[]): { system: string; user: string } {
  const user = clusters
    .map((c, i) =>
      [
        `CLUSTER ${i}`,
        `  phrases used: ${c.concepts.slice(0, 10).join(' · ')}`,
        `  spread: ${c.posts} posts across ${c.threads} thread(s), sections: ${c.sections.join(', ')}`,
        `  what individual writers wanted:`,
        ...c.examples.slice(0, 6).map((e) => `    - ${clip(e, 200)}`),
      ].join('\n'),
    )
    .join('\n\n');

  return {
    system: MAP_SYSTEM,
    user: `${user}\n\nName all ${clusters.length} clusters. Respond with JSON.`,
  };
}

/** A stable id from the need's title, so re-running the map updates a need
 *  rather than duplicating it. */
export function needIdFor(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unnamed'
  );
}

/**
 * Read the model's naming, or drop what cannot be read.
 *
 * ⚠️ A NEED WITH NO TITLE IS DROPPED, NOT DEFAULTED. The prompt offers an empty
 * title as the way to say "this cluster is not a real need", and honouring that
 * is what lets the map return six needs instead of padding to twelve. A cluster
 * the model could not name is not a need nobody has noticed; it is noise.
 */
export function parseNeeds(raw: unknown, clusters: readonly RawCluster[]): CoversNeed[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { needs?: unknown }).needs)
      ? (raw as { needs: unknown[] }).needs
      : null;
  if (!list) return [];

  const seen = new Set<string>();
  const out: CoversNeed[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;

    const index = typeof o.index === 'number' ? o.index : -1;
    const cluster = clusters[index];
    if (!cluster) continue;

    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 80) : '';
    if (!title) continue;

    const needId = needIdFor(title);
    if (seen.has(needId)) continue;
    seen.add(needId);

    const strings = (v: unknown, cap: number, max: number) =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === 'string' && x.trim().length > 1)
            .map((x) => x.trim().slice(0, cap))
            .filter((x, i, all) => all.indexOf(x) === i)
            .slice(0, max)
        : [];

    out.push({
      needId,
      title,
      whatPeopleWant: typeof o.whatPeopleWant === 'string' ? o.whatPeopleWant.trim().slice(0, 300) : '',
      phrases: strings(o.phrases, 80, 8),
      valueAreas: strings(o.valueAreas, 60, 4),
      posts: cluster.posts,
      threads: cluster.threads,
      sections: cluster.sections,
      examples: cluster.examples.slice(0, 5),
      concepts: cluster.concepts.slice(0, 10),
    });
  }

  return out.sort((a, b) => b.threads - a.threads || b.posts - a.posts);
}

// ---------------------------------------------------------------------------
// The map itself
// ---------------------------------------------------------------------------

/** `projects/{projectId}/modules/coversMap` — the counts, kept honest. */
export interface ConversationMap {
  needs: CoversNeed[];
  /** ⚠️ THE DENOMINATORS, and they are reported next to the needs rather than
   *  buried. "12 needs" from 30 posts on one board is a different claim from
   *  the same number over 300 posts across six, and a screen that shows only
   *  the need count makes them look identical. */
  postsAnalysed: number;
  /** Posts that reached the classifier at all. The rest were screened for free
   *  and say nothing about what the audience needs. */
  postsMappable: number;
  sections: string[];
  threads: number;
  /** Clusters found before the recurrence floor and the naming call. Reported
   *  so a map of 6 from 40 candidates reads as selective rather than thin. */
  clustersFound: number;
  builtAtMs: number;
  model: string;
}

export const EMPTY_MAP: ConversationMap = {
  needs: [],
  postsAnalysed: 0,
  postsMappable: 0,
  sections: [],
  threads: 0,
  clustersFound: 0,
  builtAtMs: 0,
  model: '',
};

/** The counts, measured from the rows rather than from the needs. */
export function mapCounts(rows: readonly MapInput[]): {
  postsAnalysed: number;
  postsMappable: number;
  sections: string[];
  threads: number;
} {
  const mappable = rows.filter(isMappable);
  return {
    postsAnalysed: rows.length,
    postsMappable: mappable.length,
    sections: [...new Set(mappable.map((r) => r.section))].sort(),
    threads: new Set(mappable.map((r) => r.itemId)).size,
  };
}

/** How many clusters reach the naming call. A ceiling on cost and on how much
 *  a person can read, not a target — `parseNeeds` may return fewer and often
 *  should. */
export const MAX_NEEDS = 15;

export function candidateClusters(rows: readonly MapInput[]): RawCluster[] {
  return clusterConcepts(rows).filter(isRecurring).slice(0, MAX_NEEDS);
}
