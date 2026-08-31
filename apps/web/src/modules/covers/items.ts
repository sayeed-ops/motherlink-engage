// A harvested thread, in the shape it is stored in.
//
// PURE. Parsed pages in, records out; server/covers.ts writes them. Keeping the
// mapping here means the answer to "what does a harvest actually record" is
// testable without Firestore, and the same records can be shown to a person
// before anything is saved.
//
// ════════════════════════════════════════════════════════════════════════════
// THE ITEM IS THE THREAD; THE OPPORTUNITY WILL BE A POST
//
// `items/{itemId}` is one thread and `items/{itemId}/posts/{postId}` are its
// posts, because the plan anchors an opportunity on a POST — "I grabbed Seattle
// -3.5, now it's -4.5, does it go to -6?" is the unit worth answering, and it is
// on page four of a thread about something else.
//
// Storing posts as a subcollection rather than an array on the item is what
// makes that possible: an analysis, a draft and an outcome can each point at one
// post id, and a re-harvest can add page five without rewriting page one.
// ════════════════════════════════════════════════════════════════════════════

import type { CoversPost, CoversThread, CoversThreadSummary } from './parse';
import { extractEntities, mergeEntities, type CoversEntities } from './entities';

export interface CoversItemRecord {
  itemId: string;
  projectId: string;
  platform: 'covers';
  /** Covers' own thread id. */
  externalId: string;
  section: string;
  /** From the section registry. `null` for a section nobody has classified. */
  sport: string | null;
  title: string;
  url: string;
  author: string;
  /** Thread start, from the listing row. Approximate to the hour — see
   *  parse.ts parseListingTime. `null` when the listing did not carry it. */
  createdAtSourceMs: number | null;
  /** ⚠️ NULL MEANS NOT MEASURED, NOT ZERO. A thread read directly, without its
   *  listing row, has no post or view count available anywhere on the page. A
   *  zero here would be indistinguishable from a dead thread and the screen
   *  would show it as one.
   *
   *  `postsOnSite` is Covers' own count including the opening post; compare it
   *  with `postsHarvested` to see how much of the thread this read covered. */
  postsOnSite: number | null;
  views: number | null;
  /**
   * How many posts THIS HARVEST read — not how long the thread is.
   *
   * A 400-post thread read one page deep yields 20. The name says `Harvested`
   * for the same reason `replies` may be null: a number that means "what we
   * looked at" must never be read as "what is there".
   */
  postsHarvested: number;
  /** Pages the thread has, as linked by the page we read. */
  pageCount: number;
  firstPostAtMs: number | null;
  lastPostAtMs: number | null;
  /** Title + every harvested post, merged. */
  entities: CoversEntities;
  /** Denormalised off `entities.fixture` so a query can find every thread about
   *  one game without reading a nested object. */
  fixtureKey: string | null;
}

export interface CoversPostRecord {
  postId: string;
  itemId: string;
  threadId: string;
  /** Position in the whole thread, when the page numbers its posts. */
  number: number | null;
  page: number | null;
  author: string;
  authorId: string;
  createdAtMs: number | null;
  body: string;
  chars: number;
  entities: CoversEntities;
}

export interface BuiltItem {
  item: CoversItemRecord;
  posts: CoversPostRecord[];
}

export function coversItemId(projectId: string, threadId: string): string {
  return `${projectId}_covers_${threadId}`;
}

/**
 * One read thread → the records to store.
 *
 * `summary` is the listing row, when the thread was reached through a section
 * listing. It carries the reply and view counts and the start date, none of
 * which appear on the thread page itself. Reading a thread by URL alone is a
 * legitimate path, so it is optional and its fields go null.
 */
export function buildItem(
  projectId: string,
  thread: CoversThread,
  sport: string | null,
  summary: CoversThreadSummary | null = null,
): BuiltItem {
  const itemId = coversItemId(projectId, thread.threadId);

  const posts = thread.posts.map((p) => buildPost(itemId, p, sport));
  const times = posts.map((p) => p.createdAtMs).filter((t): t is number => t !== null);

  const entities = mergeEntities([
    extractEntities(thread.title, sport),
    ...posts.map((p) => p.entities),
  ]);

  return {
    item: {
      itemId,
      projectId,
      platform: 'covers',
      externalId: thread.threadId,
      section: thread.section || summary?.section || '',
      sport,
      title: thread.title || summary?.title || '',
      url: thread.url,
      author: summary?.author ?? posts[0]?.author ?? '',
      createdAtSourceMs: summary?.createdAtMs ?? (times.length > 0 ? Math.min(...times) : null),
      postsOnSite: summary?.postsOnSite ?? null,
      views: summary?.views ?? null,
      postsHarvested: posts.length,
      pageCount: thread.pageCount,
      firstPostAtMs: times.length > 0 ? Math.min(...times) : null,
      lastPostAtMs: times.length > 0 ? Math.max(...times) : null,
      entities,
      fixtureKey: entities.fixture?.key ?? null,
    },
    posts,
  };
}

function buildPost(itemId: string, post: CoversPost, sport: string | null): CoversPostRecord {
  return {
    postId: post.postId,
    itemId,
    threadId: post.threadId,
    number: post.number,
    page: post.page,
    author: post.author,
    authorId: post.authorId,
    createdAtMs: post.createdAtMs,
    body: post.body,
    chars: post.body.length,
    entities: extractEntities(post.body, sport),
  };
}

/**
 * A one-line count of what a harvest read, for the screen and the log.
 *
 * Deliberately separates threads LISTED from threads READ: a section page is one
 * request and every thread after it is another, so the two numbers are the
 * shape of the bill.
 */
export interface HarvestSummary {
  section: string;
  listed: number;
  read: number;
  /** Listed, already held, and unchanged since the last read — so not opened.
   *  Reported rather than silently subtracted: "read 3 of 60" and "read 3,
   *  skipped 47 unchanged" describe very different runs. */
  skipped: number;
  posts: number;
  fixtures: number;
  errors: string[];
}

export function summariseHarvest(
  section: string,
  listed: number,
  built: readonly BuiltItem[],
  errors: readonly string[],
  skipped = 0,
): HarvestSummary {
  const fixtures = new Set(built.map((b) => b.item.fixtureKey).filter((k): k is string => !!k));
  return {
    section,
    listed,
    read: built.length,
    skipped,
    posts: built.reduce((n, b) => n + b.posts.length, 0),
    fixtures: fixtures.size,
    errors: [...errors],
  };
}
