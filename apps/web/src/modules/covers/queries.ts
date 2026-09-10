/**
 * How the Covers listings are ASKED FOR, as pure functions.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FILTERING AFTER `.limit()` IS BOTH A BILL AND A BUG
 *
 * These builders exist because both Covers listings used to do this:
 *
 *     const snap = await query.limit(500).get();
 *     return snap.docs.map(…).filter((d) => d.context?.section === section);
 *
 * Firestore charges for every one of those 500 documents, and the filter then
 * threw most of them away — so a queue showing twelve rows could bill five
 * hundred reads. Worse, it could also be WRONG: the limit is applied before the
 * predicate, so a section with 30 drafts sitting behind 500 other sections'
 * drafts rendered as an empty queue rather than as a truncated one. Same shape
 * for `outcome === 'opportunity'` on the analyses side, where the funnel rejects
 * roughly 95% of posts — 500 documents read to find the 12 that qualified.
 *
 * Every predicate that Firestore can evaluate is now in the query, and the
 * ordering with it, so `limit` truncates the RANKED, RELEVANT set. Each shape
 * these builders can emit needs a composite index; they are all in
 * firestore.indexes.json, and adding an option here without adding the index
 * makes the query throw FAILED_PRECONDITION rather than fall back.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * They live in `modules/` rather than `server/` so they can be tested without
 * firebase-admin or a database: `QueryLike` is structural, and a fake that
 * records the calls is enough to assert that a filter reached the query instead
 * of the array. See tests/unit/coversQueries.test.mjs.
 */

/** The slice of a Firestore `Query` these builders use. Self-returning so the
 *  concrete Query type flows through the chain and `.get()` survives. */
export interface QueryLike<Q> {
  where(field: string, op: '==', value: unknown): Q;
  orderBy(field: string, direction: 'desc'): Q;
  limit(n: number): Q;
}

/** Firestore rejects a limit of 0 and we refuse to page the whole collection,
 *  so every listing is clamped rather than trusted. */
export const clampLimit = (n: number | undefined, fallback: number, ceiling: number): number =>
  Math.max(1, Math.min(ceiling, n ?? fallback));

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface DraftQueryOptions {
  runId?: string;
  /** The section the draft was written FOR, which lives at `context.section`
   *  because a draft carries the triage context it came from. Queried at that
   *  nested path rather than copied to the top level — Firestore indexes map
   *  subfields like any other, and denormalising it would need a migration of
   *  every draft already written. */
  section?: string;
  status?: string;
  limit?: number;
}

export const DRAFT_LIMIT_DEFAULT = 100;
export const DRAFT_LIMIT_CEILING = 500;

export function coversDraftsQuery<Q extends QueryLike<Q>>(base: Q, opts: DraftQueryOptions = {}): Q {
  let q = base.where('platform', '==', 'covers');
  if (opts.runId) q = q.where('runId', '==', opts.runId);
  if (opts.status) q = q.where('status', '==', opts.status);
  if (opts.section) q = q.where('context.section', '==', opts.section);

  // Ranked in the query so the limit keeps the BEST drafts rather than an
  // arbitrary page of them that is then sorted in a browser.
  return q
    .orderBy('context.opportunityScore', 'desc')
    .limit(clampLimit(opts.limit, DRAFT_LIMIT_DEFAULT, DRAFT_LIMIT_CEILING));
}

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------

export interface TriageQueryOptions {
  runId?: string;
  section?: string;
  /** False — the default — narrows to `outcome == 'opportunity'` IN THE QUERY.
   *  The funnel rejects the large majority of posts, so this is the single
   *  biggest read saving in the module: generation asked for 500 analyses to
   *  work on the dozen that qualified. */
  all?: boolean;
  limit?: number;
}

export const TRIAGE_LIMIT_DEFAULT = 500;
export const TRIAGE_LIMIT_CEILING = 5000;

export function coversTriageQuery<Q extends QueryLike<Q>>(base: Q, opts: TriageQueryOptions = {}): Q {
  let q = base.where('platform', '==', 'covers');
  if (opts.runId) q = q.where('runId', '==', opts.runId);
  if (!opts.all) q = q.where('outcome', '==', 'opportunity');
  if (opts.section) q = q.where('section', '==', opts.section);

  return q
    .orderBy('score', 'desc')
    .limit(clampLimit(opts.limit, TRIAGE_LIMIT_DEFAULT, TRIAGE_LIMIT_CEILING));
}
